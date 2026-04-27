/**
 * Discuss Runner — Claude Opus + GPT 5.4 Debate Orchestrator.
 *
 * Triggered by `@discuss <topic>`. Runs a multi-round debate between
 * Claude Opus (via Claude Agent SDK) and GPT 5.4 (via WHAM Responses API).
 * Each round is streamed to the user. Users can intervene mid-debate.
 * The debate ends when both models signal [CONSENSUS] or MAX_ROUNDS is reached.
 */

import fs from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  ContainerInput,
  IPC_INPUT_DIR,
  writeOutput,
  log,
  drainIpcInput,
  waitForIpcMessage,
  shouldClose,
} from './shared.js';
import { callGptSimple } from './openai-runner.js';

// --- Configuration ---

const CLAUDE_MODEL = process.env.DISCUSS_CLAUDE_MODEL || 'claude-opus-4-7';
const CLAUDE_EFFORT = 'max';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4';
const OPENAI_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'xhigh';
const MAX_ROUNDS = parseInt(process.env.DISCUSS_MAX_ROUNDS || '7', 10);

const CONSENSUS_TAG = '[CONSENSUS]';
const DISCUSS_TRIGGER = /^@discuss\s*/i;

// Extract the actual user message from the XML envelope produced by router.ts
function extractTopicFromPrompt(prompt: string): string {
  const msgMatches = [...prompt.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  if (msgMatches.length > 0) {
    const lastMsg = msgMatches[msgMatches.length - 1][1].trim();
    return lastMsg.replace(DISCUSS_TRIGGER, '').trim();
  }
  const stripped = prompt.replace(/<[^>]+>/g, ' ').trim();
  return stripped.replace(DISCUSS_TRIGGER, '').trim();
}

// --- Types ---

interface DebateMessage {
  role: 'claude' | 'gpt' | 'moderator';
  content: string;
}

// --- System prompts ---

function buildClaudeSystemPrompt(topic: string): string {
  return `You are Claude Opus, participating in a structured intellectual debate with GPT 5.4 on the following topic:

"${topic}"

Rules:
- Provide thoughtful, well-reasoned arguments from your perspective.
- Engage genuinely with GPT's arguments. Do not strawman or dismiss.
- When you find GPT's point compelling, acknowledge it explicitly.
- If you believe a genuine consensus is emerging — where both sides have converged on a substantive agreement — start your response with "[CONSENSUS]" followed by the agreed-upon conclusion.
- Do NOT signal consensus prematurely or merely to be agreeable. Only use [CONSENSUS] when you genuinely believe the core disagreements have been resolved.
- Provide thorough, in-depth responses. Do not artificially shorten your arguments.
- If a [Moderator] message appears, incorporate their direction into your next response.
- Respond in the same language as the user's topic.
- Use plain text only. No markdown syntax (no #, ##, **, [], tables, etc.).
- You have WebSearch and WebFetch tools available. Use them whenever the debate depends on recent facts, statistics, news, prices, regulations, or any claim you cannot verify from memory. Cite the source URL inline when you rely on retrieved information.`;
}

function buildGptSystemPrompt(topic: string): string {
  return `You are GPT 5.4, participating in a structured intellectual debate with Claude Opus on the following topic:

"${topic}"

Rules:
- Provide thoughtful, well-reasoned arguments from your perspective.
- Engage genuinely with Claude's arguments. Do not strawman or dismiss.
- When you find Claude's point compelling, acknowledge it explicitly.
- If you believe a genuine consensus is emerging — where both sides have converged on a substantive agreement — start your response with "[CONSENSUS]" followed by the agreed-upon conclusion.
- Do NOT signal consensus prematurely or merely to be agreeable. Only use [CONSENSUS] when you genuinely believe the core disagreements have been resolved.
- Provide thorough, in-depth responses. Do not artificially shorten your arguments.
- If a [Moderator] message appears, incorporate their direction into your next response.
- Respond in the same language as the user's topic.
- Use plain text only. No markdown syntax (no #, ##, **, [], tables, etc.).
- You have a web_search tool available. Use it whenever the debate depends on recent facts, statistics, news, prices, regulations, or any claim you cannot verify from memory. Cite the source URL inline when you rely on retrieved information.`;
}

// --- Claude API (via Claude Agent SDK — uses subscription auth) ---

async function callClaude(
  system: string,
  prompt: string,
): Promise<string> {
  log(`[discuss] Calling Claude (${CLAUDE_MODEL}) via Agent SDK...`);

  let resultText = '';

  for await (const message of query({
    prompt,
    options: {
      model: CLAUDE_MODEL,
      systemPrompt: system,
      tools: ['WebSearch', 'WebFetch'],
      maxTurns: 5,
      effort: 'max',
      thinking: { type: 'adaptive' },
      persistSession: false,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === 'result') {
      const rm = message as Record<string, unknown>;
      resultText = (rm.result as string) || '';
    }
  }

  log(`[discuss] Claude responded (${resultText.length} chars)`);
  return resultText;
}

// --- GPT API (via WHAM Responses API — uses ChatGPT subscription) ---

async function callGpt(system: string, prompt: string): Promise<string> {
  log(`[discuss] Calling GPT (${OPENAI_MODEL}) via WHAM API...`);

  const result = await callGptSimple(system, prompt, OPENAI_MODEL);

  log(`[discuss] GPT responded (${result.text.length} chars, model: ${result.model})`);
  return result.text;
}

// --- Debate history → prompt builders ---

function buildClaudePrompt(history: DebateMessage[], topic: string, round: number): string {
  if (history.length === 0) {
    return `The user's original request:\n"${topic}"\n\nPlease present your initial position on this topic.`;
  }

  const parts: string[] = [
    `[User's original request]: "${topic}"`,
    `[Current round]: ${round}`,
    '',
    '--- Debate history ---',
  ];
  for (const msg of history) {
    if (msg.role === 'claude') {
      parts.push(`[Your previous response]:\n${msg.content}`);
    } else if (msg.role === 'gpt') {
      parts.push(`[GPT 5.4's response]:\n${msg.content}`);
    } else if (msg.role === 'moderator') {
      parts.push(`[Moderator intervention]:\n${msg.content}`);
    }
  }

  parts.push(
    '\n--- Instructions ---',
    'Provide your next response. Always keep the user\'s original request as your primary focus.',
    'Engage with GPT\'s latest arguments, but ensure your response directly serves the user\'s original question.',
    'Add new depth, examples, or perspectives — do not merely repeat previous points.',
  );
  return parts.join('\n\n');
}

function buildGptPrompt(topic: string, history: DebateMessage[], round: number): string {
  const parts: string[] = [
    `[User's original request]: "${topic}"`,
    `[Current round]: ${round}`,
    '',
    '--- Debate history ---',
  ];

  for (const msg of history) {
    if (msg.role === 'claude') {
      parts.push(`[Claude Opus]:\n${msg.content}\n`);
    } else if (msg.role === 'gpt') {
      parts.push(`[GPT 5.4 (you)]:\n${msg.content}\n`);
    } else if (msg.role === 'moderator') {
      parts.push(`[Moderator]:\n${msg.content}\n`);
    }
  }

  parts.push(
    '--- Instructions ---',
    'Provide your next response as GPT 5.4. Always keep the user\'s original request as your primary focus.',
    'Engage with Claude\'s latest arguments, but ensure your response directly serves the user\'s original question.',
    'Add new depth, examples, or perspectives — do not merely repeat previous points.',
  );
  return parts.join('\n');
}

// --- Consensus detection ---

function hasConsensus(text: string): boolean {
  return text.trimStart().startsWith(CONSENSUS_TAG);
}

// --- Check for user intervention via IPC ---

function checkUserIntervention(history: DebateMessage[]): void {
  const messages = drainIpcInput();
  if (messages.length === 0) return;

  const combined = messages.map((m) => m.text).join('\n');
  history.push({ role: 'moderator', content: combined });
  log(`[discuss] Moderator intervention: ${combined.slice(0, 200)}`);

  writeOutput({
    status: 'success',
    result: `\n👤 Moderator:\n${combined}`,
    model: 'discuss',
  });
}

// --- Generate final conclusion ---

async function generateConclusion(
  topic: string,
  history: DebateMessage[],
): Promise<string> {
  const debateSummary = history
    .map((m) => {
      const label =
        m.role === 'claude' ? 'Claude Opus' : m.role === 'gpt' ? 'GPT 5.4' : 'Moderator';
      return `[${label}]: ${m.content}`;
    })
    .join('\n\n');

  const system = `You are a neutral synthesizer. Given a debate between Claude Opus and GPT 5.4, produce a clear, consolidated conclusion that:
1. Identifies the key points of agreement
2. Notes any remaining differences in perspective
3. Provides an actionable, balanced conclusion
Use plain text only. No markdown. Respond in the same language as the debate topic.`;

  const prompt = `Topic: "${topic}"\n\nFull debate transcript:\n\n${debateSummary}\n\nPlease synthesize the final conclusion.`;

  return callClaude(system, prompt);
}

// --- Archive debate to conversations/ for main agent access ---

const DISCUSS_INDEX_MAX_ENTRIES = 10;
const DISCUSS_EXPIRY_DAYS = 10;

function archiveDebate(topic: string, history: DebateMessage[], conclusion?: string): string | undefined {
  try {
    const dir = '/workspace/group/conversations';
    fs.mkdirSync(dir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const slug = topic.slice(0, 50).replace(/[^a-zA-Z0-9가-힣\s]/g, '').trim().replace(/\s+/g, '-');
    const filename = `${date}-discuss-${slug}.md`;
    const filePath = `${dir}/${filename}`;

    const lines: string[] = [
      `# Discuss: ${topic.slice(0, 100)}`,
      `Date: ${new Date().toISOString()}`,
      `Participants: Claude Opus, GPT 5.4`,
      `Rounds: ${history.filter(m => m.role === 'claude').length}`,
      '',
      '## User Question',
      '',
      topic,
      '',
    ];

    for (const msg of history) {
      const label = msg.role === 'claude' ? 'Claude Opus' : msg.role === 'gpt' ? 'GPT 5.4' : 'Moderator';
      lines.push(`## ${label}`, '', msg.content, '');
    }

    if (conclusion) {
      lines.push('## Conclusion', '', conclusion, '');
    }

    fs.writeFileSync(filePath, lines.join('\n'));
    log(`[discuss] Archived debate to ${filePath}`);
    return filename;
  } catch (err) {
    log(`[discuss] Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function updateDiscussIndex(topic: string, history: DebateMessage[], conclusion?: string, archiveFilename?: string): void {
  try {
    if (history.length === 0) {
      log('[discuss] Empty history, skipping index update');
      return;
    }

    const indexPath = '/workspace/group/conversations/recent-discussions.md';
    const date = new Date().toISOString().split('T')[0];
    const rounds = history.filter(m => m.role === 'claude').length;
    const truncatedConclusion = conclusion
      ? conclusion.slice(0, 100) + (conclusion.length > 100 ? '...' : '')
      : 'No conclusion';

    const entry = [
      `### ${date}: ${topic.slice(0, 100)}`,
      `Rounds: ${rounds} | Conclusion: ${truncatedConclusion}`,
      archiveFilename ? `Transcript: ${archiveFilename}` : '',
    ].filter(Boolean).join('\n');

    let existingEntries: string[] = [];
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      existingEntries = content.split(/(?=^### )/m)
        .filter(e => e.trim() && !e.startsWith('# Recent') && !e.startsWith('Use Read'));
    }

    existingEntries.unshift(entry);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DISCUSS_EXPIRY_DAYS);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    existingEntries = existingEntries.filter(e => {
      const dateMatch = e.match(/^### (\d{4}-\d{2}-\d{2})/);
      return dateMatch ? dateMatch[1] >= cutoffStr : true;
    });

    if (existingEntries.length > DISCUSS_INDEX_MAX_ENTRIES) {
      existingEntries = existingEntries.slice(0, DISCUSS_INDEX_MAX_ENTRIES);
    }

    const indexContent = '# Recent Discussions\n\nUse Read to open the transcript file for full debate details.\n\n' + existingEntries.join('\n---\n\n');
    fs.writeFileSync(indexPath, indexContent);
    log(`[discuss] Updated discussions index at ${indexPath}`);
  } catch (err) {
    log(`[discuss] Failed to update index: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function cleanupExpiredDebates(): void {
  try {
    const dir = '/workspace/group/conversations';
    if (!fs.existsSync(dir)) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DISCUSS_EXPIRY_DAYS);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('20') || !file.includes('-discuss-')) continue;
      const fileDate = file.slice(0, 10);
      if (fileDate < cutoffStr) {
        fs.unlinkSync(`${dir}/${file}`);
        log(`[discuss] Removed expired debate: ${file}`);
      }
    }
  } catch (err) {
    log(`[discuss] Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Main debate loop ---

async function runDebate(topic: string): Promise<void> {
  const history: DebateMessage[] = [];
  const claudeSystem = buildClaudeSystemPrompt(topic);
  const gptSystem = buildGptSystemPrompt(topic);

  writeOutput({
    status: 'success',
    result: `━━━ Discuss: ${topic.slice(0, 100)} ━━━`,
    model: 'discuss',
  });

  let claudeAgreed = false;
  let gptAgreed = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log(`[discuss] === Round ${round}/${MAX_ROUNDS} ===`);

    if (shouldClose()) {
      log('[discuss] Close sentinel detected');
      break;
    }

    if (round > 1) checkUserIntervention(history);

    // --- Claude's turn ---
    let claudeResponse: string;
    try {
      claudeResponse = await callClaude(claudeSystem, buildClaudePrompt(history, topic, round));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`[discuss] Claude error: ${errMsg}`);
      writeOutput({ status: 'error', result: `Claude error in round ${round}: ${errMsg}`, model: 'discuss' });
      break;
    }

    if (!claudeResponse.trim()) {
      log('[discuss] Claude returned empty response, aborting debate');
      writeOutput({ status: 'error', result: `Claude returned empty response in round ${round}. Debate aborted.`, model: 'discuss' });
      break;
    }

    history.push({ role: 'claude', content: claudeResponse });
    writeOutput({
      status: 'success',
      result: `[Round ${round}]\n\n🔵 Claude Opus:\n${claudeResponse}`,
      model: CLAUDE_MODEL,
      effort: CLAUDE_EFFORT,
    });

    if (shouldClose()) break;
    checkUserIntervention(history);

    // --- Mid-round consensus check (Claude just spoke) ---
    claudeAgreed = hasConsensus(claudeResponse);
    if (claudeAgreed && gptAgreed) {
      log('[discuss] Both models signaled consensus (after Claude turn)!');
      writeOutput({ status: 'success', result: '\n✅ Both models reached consensus.', model: 'discuss' });
      break;
    }

    // --- GPT's turn ---
    let gptResponse: string;
    try {
      gptResponse = await callGpt(gptSystem, buildGptPrompt(topic, history, round));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`[discuss] GPT error: ${errMsg}`);
      writeOutput({ status: 'error', result: `GPT error in round ${round}: ${errMsg}`, model: 'discuss' });
      break;
    }

    if (!gptResponse.trim()) {
      log('[discuss] GPT returned empty response, aborting debate');
      writeOutput({ status: 'error', result: `GPT returned empty response in round ${round}. Debate aborted.`, model: 'discuss' });
      break;
    }

    history.push({ role: 'gpt', content: gptResponse });
    writeOutput({
      status: 'success',
      result: `\n🟢 GPT 5.4:\n${gptResponse}`,
      model: OPENAI_MODEL,
      effort: OPENAI_EFFORT,
    });

    // --- End-of-round consensus check (GPT just spoke) ---
    gptAgreed = hasConsensus(gptResponse);
    if (claudeAgreed && gptAgreed) {
      log('[discuss] Both models signaled consensus!');
      writeOutput({ status: 'success', result: '\n✅ Both models reached consensus.', model: 'discuss' });
      break;
    }
  }

  // --- Final conclusion ---
  log('[discuss] Generating final conclusion...');
  let conclusion: string | undefined;
  try {
    conclusion = await generateConclusion(topic, history);
    writeOutput({ status: 'success', result: `\n━━━ Conclusion ━━━\n${conclusion}`, model: 'discuss' });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[discuss] Conclusion error: ${errMsg}`);
    writeOutput({ status: 'error', result: `Failed to generate conclusion: ${errMsg}`, model: 'discuss' });
  }

  // --- Archive debate for main agent access ---
  const archiveFile = archiveDebate(topic, history, conclusion);
  updateDiscussIndex(topic, history, conclusion, archiveFile);
  cleanupExpiredDebates();
}

// --- Entry point ---

export async function runDiscuss(containerInput: ContainerInput): Promise<void> {
  log('[discuss] Starting discuss runner');
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  try { fs.unlinkSync(`${IPC_INPUT_DIR}/_close`); } catch { /* ignore */ }

  try {
    let topic = extractTopicFromPrompt(containerInput.prompt);
    if (!topic) {
      writeOutput({
        status: 'error',
        result: 'Please provide a topic after @discuss. Example: @discuss Should we use microservices or monolith?',
      });
      return;
    }

    const pending = drainIpcInput();
    if (pending.length > 0) {
      topic += '\n' + pending.map((m) => m.text).join('\n');
    }

    await runDebate(topic);
    writeOutput({ status: 'success', result: null });

    // Multi-turn: wait for new topics
    log('[discuss] Debate complete, waiting for next topic...');
    while (true) {
      const nextMsg = await waitForIpcMessage();
      if (nextMsg === null) {
        log('[discuss] Close sentinel received, exiting');
        break;
      }

      const newTopic = nextMsg.text.replace(DISCUSS_TRIGGER, '').trim();
      if (newTopic) {
        log(`[discuss] New topic: ${newTopic.slice(0, 100)}`);
        await runDebate(newTopic);
        writeOutput({ status: 'success', result: null });
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[discuss] Fatal error: ${errMsg}`);
    writeOutput({ status: 'error', result: null, error: errMsg });
  }
}
