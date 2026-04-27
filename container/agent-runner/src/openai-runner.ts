/**
 * OpenAI Agent Runner for NanoClaw.
 * Supports two authentication modes:
 *   - "apikey": Chat Completions API (api.openai.com) — pay-per-token
 *   - "subscription": WHAM Responses API (chatgpt.com) — ChatGPT subscription quota
 *
 * Shares the same IPC, prompt, and memory infrastructure as the Claude runner.
 */

import fs from 'fs';

import {
  ContainerInput,
  ContainerOutput,
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL,
  writeOutput,
  log,
  drainIpcInput,
  waitForIpcMessage,
  shouldClose,
  runScript,
} from './shared.js';

import {
  TOOL_DEFINITIONS,
  responsesToolDefinitions,
  executeTool,
} from './tools.js';
import { hasOAuthTokens, withAutoRefresh } from './openai-auth.js';

// --- Auth mode ---

type AuthMode = 'subscription' | 'apikey';

function detectAuthMode(): AuthMode {
  const envMode = process.env.OPENAI_AUTH_MODE;
  if (envMode === 'subscription') return 'subscription';
  if (envMode === 'apikey') return 'apikey';
  // Auto-detect: prefer subscription if OAuth tokens exist
  if (hasOAuthTokens()) return 'subscription';
  return 'apikey';
}

// --- Types ---

interface AgentLoopResult {
  result: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  numTurns: number;
  model: string;
}

// =============================================================================
// Chat Completions API (apikey mode)
// =============================================================================

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function callChatCompletions(
  messages: ChatMessage[],
  model: string,
  baseUrl: string,
  apiKey?: string,
  reasoningEffort?: string,
): Promise<ChatCompletionResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body: Record<string, unknown> = {
    model,
    messages,
    tools: TOOL_DEFINITIONS,
  };
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(
      `OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return (await response.json()) as ChatCompletionResponse;
}

async function runChatCompletionsLoop(
  systemPrompt: string,
  initialPrompt: string,
  model: string,
  baseUrl: string,
  apiKey: string | undefined,
  ipcContext: { chatJid: string; groupFolder: string; isMain: boolean },
): Promise<AgentLoopResult> {
  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: initialPrompt });

  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || undefined;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let numTurns = 0;
  let lastModel = model;

  for (let turn = 0; turn < 50; turn++) {
    numTurns++;
    log(`[openai:apikey] Turn ${numTurns}, messages: ${messages.length}`);

    const response = await callChatCompletions(messages, model, baseUrl, apiKey, reasoningEffort);

    if (response.usage) {
      totalInputTokens += response.usage.prompt_tokens;
      totalOutputTokens += response.usage.completion_tokens;
    }
    lastModel = response.model || model;

    const choice = response.choices[0];
    if (!choice) throw new Error('No choices in response');

    const msg = choice.message;
    messages.push({
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        result: msg.content,
        totalInputTokens,
        totalOutputTokens,
        numTurns,
        model: lastModel,
      };
    }

    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      log(`[openai:apikey] Tool: ${tc.function.name}`);
      const result = await executeTool(tc.function.name, args, ipcContext);
      messages.push({
        role: 'tool',
        content: result.output,
        tool_call_id: tc.id,
      });
    }
  }

  return {
    result: '[Max turns reached]',
    totalInputTokens,
    totalOutputTokens,
    numTurns,
    model: lastModel,
  };
}

// =============================================================================
// WHAM Responses API (subscription mode)
// =============================================================================

interface ResponsesInputItem {
  role: string;
  content: Array<{ type: string; text: string }>;
}

interface ResponsesToolCall {
  id: string;
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
}

interface ResponsesOutputItem {
  type: string;
  // For text output (flat or nested)
  text?: string;
  content?: Array<{ type: string; text: string }>;
  // For function calls
  id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface ResponsesAPIResponse {
  id: string;
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

/** Extract text from a ResponsesOutputItem (handles both flat and nested content) */
function extractText(item: ResponsesOutputItem): string | undefined {
  if (item.text) return item.text;
  if (item.content) {
    return item.content
      .filter((c) => c.type === 'output_text' && c.text)
      .map((c) => c.text)
      .join('');
  }
  return undefined;
}

const WHAM_BASE_URL = 'https://chatgpt.com/backend-api/wham';

/**
 * Parse SSE stream into events. Handles multi-line data fields and
 * event/data pairs per the SSE specification (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 */
function parseSSEEvents(
  raw: string,
): Array<{ event: string | null; data: string }> {
  const events: Array<{ event: string | null; data: string }> = [];
  let currentEvent: string | null = null;
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '');

    if (trimmed === '') {
      // Empty line = event boundary
      if (dataLines.length > 0) {
        events.push({ event: currentEvent, data: dataLines.join('\n') });
        dataLines.length = 0;
        currentEvent = null;
      }
      continue;
    }

    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
    // Ignore other fields (id:, retry:, comments)
  }

  // Flush remaining
  if (dataLines.length > 0) {
    events.push({ event: currentEvent, data: dataLines.join('\n') });
  }

  return events;
}

async function callResponsesAPI(
  instructions: string,
  input: ResponsesInputItem[],
  model: string,
  authHeaders: Record<string, string>,
  options?: { tools?: boolean; reasoningEffort?: string },
): Promise<ResponsesAPIResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
  };

  const includeTools = options?.tools !== false;
  const body: Record<string, unknown> = {
    model,
    input,
    store: false,
    stream: true,
  };
  if (instructions) {
    body.instructions = instructions;
  }
  if (includeTools) {
    body.tools = [
      ...responsesToolDefinitions(),
      { type: 'web_search' },
    ];
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  } else {
    // Single-turn text-only callers (e.g. @discuss) still get server-side web_search
    // so the model can ground arguments in fresh data without a client tool-execution loop.
    body.tools = [{ type: 'web_search' }];
    body.tool_choice = 'auto';
  }
  if (options?.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
  }

  const response = await fetch(`${WHAM_BASE_URL}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(
      `WHAM API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const rawText = await response.text();
  const sseEvents = parseSSEEvents(rawText);

  const debugEvents = process.env.DEBUG_WHAM_EVENTS === '1';
  const requestReasoning = JSON.stringify(body.reasoning ?? null);

  if (debugEvents) {
    log(`[openai:wham:events] total SSE events=${sseEvents.length}, request.reasoning=${requestReasoning}`);
  }

  const seenTypes: string[] = [];
  let lastResponse: ResponsesAPIResponse | null = null;
  let streamedText = '';

  for (const evt of sseEvents) {
    if (evt.data === '[DONE]') {
      seenTypes.push('[DONE]');
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      continue;
    }

    const type = (parsed.type as string) || evt.event || 'unknown';
    seenTypes.push(type);

    if (debugEvents && seenTypes.length <= 30) {
      const preview = JSON.stringify(parsed).slice(0, 300);
      log(`[openai:wham:event#${seenTypes.length}] ${type} ${preview}`);
    }

    // Accumulate streamed text deltas. WHAM sometimes returns response.completed
    // with an empty output array even though text was streamed via deltas.
    if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
      streamedText += parsed.delta;
    } else if (type === 'response.output_text.done' && typeof parsed.text === 'string') {
      // done event carries the full text for the item; prefer it if present
      streamedText = parsed.text;
    }

    // Primary: response.completed carries the full response
    if (type === 'response.completed' || type === 'response.done') {
      const resp = (parsed.response ?? parsed) as ResponsesAPIResponse;
      // If output is missing or empty but we captured streamed text, synthesize a message item
      if ((!resp?.output || resp.output.length === 0) && streamedText) {
        log(`[openai:wham] Synthesizing output from streamed deltas (${streamedText.length} chars)`);
        return {
          ...resp,
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: streamedText }],
            },
          ],
        } as ResponsesAPIResponse;
      }
      // Diagnostic: response.completed arrived with empty output AND no streamed deltas —
      // this is the failure mode. Dump context immediately so we can identify the missing event.
      if ((!resp?.output || resp.output.length === 0) && !streamedText) {
        log(`[openai:wham:empty] seenTypes=[${seenTypes.join(', ')}]`);
        log(`[openai:wham:empty] request.reasoning=${requestReasoning}, model=${model}`);
        log(`[openai:wham:empty] raw SSE (last 8000 chars):\n${rawText.slice(-8000)}`);
      }
      if (resp?.output && resp.output.length > 0) return resp;
      lastResponse = resp;
    }
  }

  // Last resort: if we have streamed text but never saw a usable completed event
  if (streamedText) {
    log(`[openai:wham] No completed event with output, using streamed text (${streamedText.length} chars)`);
    return {
      id: (lastResponse?.id as string) || '',
      model: (lastResponse?.model as string) || '',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: streamedText }],
        },
      ],
      usage: lastResponse?.usage,
    } as ResponsesAPIResponse;
  }

  // Fallback: return last captured response
  if (lastResponse) {
    log(`[openai:wham] Using fallback response from last event`);
    return lastResponse;
  }

  log(`[openai:wham] Seen event types: ${seenTypes.join(', ')}`);
  log(`[openai:wham] Raw SSE (last 1000 chars): ${rawText.slice(-1000)}`);
  throw new Error('No response.completed event received from WHAM streaming API');
}

/**
 * Simple single-turn GPT call for non-agentic use (e.g., debate/discuss).
 * No tool calling — just text in, text out.
 * Uses subscription (WHAM) if available, falls back to API key (Chat Completions).
 */
export async function callGptSimple(
  system: string,
  userPrompt: string,
  model: string,
): Promise<{ text: string; model: string }> {
  const authMode = detectAuthMode();

  if (authMode === 'subscription') {
    const input: ResponsesInputItem[] = [
      { role: 'user', content: [{ type: 'input_text', text: userPrompt }] },
    ];

    const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || undefined;
    const resp = await withAutoRefresh(async (headers) =>
      callResponsesAPI(system, input, model, headers, { tools: false, reasoningEffort }),
    );

    const text =
      resp.output
        ?.map((item) => extractText(item))
        .filter(Boolean)
        .join('') || '';

    if (!text) {
      log(`[openai:wham:diag] EMPTY TEXT. Full resp.output: ${JSON.stringify(resp.output)?.slice(0, 3000)}`);
      log(`[openai:wham:diag] resp.model=${resp.model}, usage=${JSON.stringify(resp.usage)}`);
      log(`[openai:wham:diag] authMode=${authMode}, requested.reasoning.effort=${reasoningEffort ?? 'none'}, requested.model=${model}`);
    }

    return { text, model: resp.model || model };
  }

  // API key mode
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.OPENAI_API_KEY;
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userPrompt },
  ];

  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || undefined;
  const resp = await callChatCompletions(messages, model, baseUrl, apiKey, reasoningEffort);
  const text = resp.choices[0]?.message?.content || '';
  return { text, model: resp.model || model };
}

/**
 * Convert Responses API output items to input items for the next turn.
 * The Responses API is stateless — we must send the full history each time.
 */
function outputToInput(output: ResponsesOutputItem[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];

  for (const item of output) {
    const text = extractText(item);
    if (item.type === 'message' && text) {
      items.push({
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      });
    }
  }

  return items;
}

async function runResponsesLoop(
  systemPrompt: string,
  initialPrompt: string,
  model: string,
  ipcContext: { chatJid: string; groupFolder: string; isMain: boolean },
): Promise<AgentLoopResult> {
  // Build conversation input (stateless — full history each request)
  const conversationInput: ResponsesInputItem[] = [
    {
      role: 'user',
      content: [{ type: 'input_text', text: initialPrompt }],
    },
  ];

  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || undefined;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let numTurns = 0;
  let lastModel = model;

  for (let turn = 0; turn < 50; turn++) {
    numTurns++;
    log(
      `[openai:subscription] Turn ${numTurns}, input items: ${conversationInput.length}`,
    );

    const response = await withAutoRefresh(async (headers) =>
      callResponsesAPI(systemPrompt, conversationInput, model, headers, { reasoningEffort }),
    );

    if (response.usage) {
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
    }
    lastModel = response.model || model;

    // Check for function calls in output
    const functionCalls = response.output.filter(
      (o) => o.type === 'function_call',
    );
    const textOutputs = response.output.filter(
      (o) => o.type === 'message' && extractText(o),
    );

    // If no function calls, we're done
    if (functionCalls.length === 0) {
      const resultText = textOutputs.map((o) => extractText(o)).join('\n');
      return {
        result: resultText || null,
        totalInputTokens,
        totalOutputTokens,
        numTurns,
        model: lastModel,
      };
    }

    // Add assistant's output to conversation history
    // For Responses API: include the raw output items as-is
    for (const item of response.output) {
      if (item.type === 'function_call') {
        conversationInput.push({
          role: 'assistant',
          content: [
            {
              type: 'function_call',
              text: JSON.stringify({
                id: item.id,
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments,
              }),
            },
          ],
        });
      } else if (item.type === 'message' && extractText(item)) {
        conversationInput.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: extractText(item)! }],
        });
      }
    }

    // Execute function calls and add results
    for (const fc of functionCalls) {
      const toolName = fc.name!;
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(fc.arguments || '{}');
      } catch {
        toolArgs = {};
      }

      log(`[openai:subscription] Tool: ${toolName}`);
      const toolResult = await executeTool(toolName, toolArgs, ipcContext);

      // Add tool result as function_call_output
      conversationInput.push({
        role: 'user',
        content: [
          {
            type: 'function_call_output',
            text: JSON.stringify({
              call_id: fc.call_id,
              output: toolResult.output,
            }),
          },
        ],
      });
    }
  }

  return {
    result: '[Max turns reached]',
    totalInputTokens,
    totalOutputTokens,
    numTurns,
    model: lastModel,
  };
}

// =============================================================================
// Main entry point
// =============================================================================

export async function runOpenAI(containerInput: ContainerInput): Promise<void> {
  const authMode = detectAuthMode();
  const model = process.env.OPENAI_MODEL || 'gpt-5.4';

  log(`[openai] Auth mode: ${authMode}, model: ${model}`);

  const ipcContext = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isMain: containerInput.isMain,
  };

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // @gpt path — lightweight assistant persona, no group CLAUDE.md injection.
  // (WHAM Responses API also rejects empty `instructions` with 400.)
  const systemPrompt = `당신은 pilming-claw의 개인 AI 비서입니다.
기본적으로는 비서답게 핵심을 놓치지 않으면서 간결하게 답합니다. 불필요한 서론이나 사족은 덧붙이지 않습니다.
다만 사용자의 질문이 깊은 고민이나 자세한 분석을 요구하는 경우에는 필요한 만큼 충분히 깊고 자세하게 답합니다.
특별한 요청이 없는 한 한국어로 응답합니다.`;

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  let currentRequestId = containerInput.requestId;

  // Drain pending IPC messages
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map((m) => m.text).join('\n');
    const lastPendingId = pending[pending.length - 1].requestId;
    if (lastPendingId) currentRequestId = lastPendingId;
  }

  // Script phase (for scheduled tasks)
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({ status: 'success', result: null });
      return;
    }

    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop
  const startTime = Date.now();

  try {
    while (true) {
      log(
        `[openai] Starting query (mode: ${authMode}, requestId: ${currentRequestId || 'none'})...`,
      );

      let result: AgentLoopResult;

      if (authMode === 'subscription') {
        result = await runResponsesLoop(
          systemPrompt,
          prompt,
          model,
          ipcContext,
        );
      } else {
        const baseUrl =
          process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        const apiKey = process.env.OPENAI_API_KEY;
        result = await runChatCompletionsLoop(
          systemPrompt,
          prompt,
          model,
          baseUrl,
          apiKey,
          ipcContext,
        );
      }

      const durationMs = Date.now() - startTime;

      log(
        `[openai] Query done: mode=${authMode}, model=${result.model}, tokens=${result.totalInputTokens}/${result.totalOutputTokens}, turns=${result.numTurns}`,
      );

      writeOutput({
        status: 'success',
        result: result.result,
        requestId: currentRequestId,
        model: result.model,
        usage: {
          input_tokens: result.totalInputTokens,
          output_tokens: result.totalOutputTokens,
        },
        durationMs,
        numTurns: result.numTurns,
      });

      if (shouldClose()) {
        log('[openai] Close sentinel detected, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null });

      log('[openai] Query ended, waiting for next IPC message...');

      const nextMsg = await waitForIpcMessage();
      if (nextMsg === null) {
        log('[openai] Close sentinel received, exiting');
        break;
      }

      log(
        `[openai] Got new message (${nextMsg.text.length} chars), starting new query`,
      );
      prompt = nextMsg.text;
      currentRequestId = nextMsg.requestId;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`[openai] Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  }
}
