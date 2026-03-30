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

import { buildSystemPrompt } from './system-prompt.js';
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
): Promise<ChatCompletionResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, tools: TOOL_DEFINITIONS }),
    signal: AbortSignal.timeout(300_000),
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

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let numTurns = 0;
  let lastModel = model;

  for (let turn = 0; turn < 50; turn++) {
    numTurns++;
    log(`[openai:apikey] Turn ${numTurns}, messages: ${messages.length}`);

    const response = await callChatCompletions(messages, model, baseUrl, apiKey);

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

async function callResponsesAPI(
  instructions: string,
  input: ResponsesInputItem[],
  model: string,
  authHeaders: Record<string, string>,
): Promise<ResponsesAPIResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
  };

  const body = {
    model,
    instructions,
    input,
    store: false,
    stream: true,
    tools: responsesToolDefinitions(),
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };

  const response = await fetch(`${WHAM_BASE_URL}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(
      `WHAM API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  // Parse SSE stream — WHAM requires stream:true, so we read the response.done event
  const text = await response.text();

  const seenTypes: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') { seenTypes.push('[DONE]'); continue; }
    try {
      const parsed = JSON.parse(data);
      seenTypes.push(parsed.type || 'unknown');
      if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
        return parsed.response as ResponsesAPIResponse;
      }
    } catch {
      // ignore malformed lines
    }
  }

  log(`[openai:wham] Seen event types: ${seenTypes.join(', ')}`);
  throw new Error('No response.completed event received from WHAM streaming API');
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
      callResponsesAPI(systemPrompt, conversationInput, model, headers),
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

  // Build system prompt from CLAUDE.md files
  const systemPrompt = buildSystemPrompt(containerInput);

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
