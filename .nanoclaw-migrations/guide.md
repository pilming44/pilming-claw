# NanoClaw Migration Guide

Generated: 2026-04-27 13:30 KST
Base: `4383e3e` (chore: bump version to 1.2.35, 2026-03-26)
HEAD at generation: `2768192`
Upstream: `f8c3d02` (v2.0.14)
Migration tier: **3 (complex)**
Source plan: `/Users/pilming/.claude/plans/lexical-juggling-teapot.md`

---

## Migration Plan

1. Backup tag/branch before touching anything (already done: `pre-v2-migration-2768192-20260427-131755`).
2. Worktree-based upgrade (Phase 2 of `migrate-nanoclaw` skill): `git worktree add .upgrade-worktree upstream/main --detach`.
3. Reapply standard channel/provider skills first (`/add-codex`, `/add-slack`, plus other `/add-*` skills the user runs).
4. Copy in-tree container skills directory by directory.
5. Reapply customizations grouped by area (config/triggers → host source → container agent-runner). Container agent-runner is the largest single area (~+1485 lines of OpenAI/Discuss logic).
6. Validate in worktree (`pnpm install`, `pnpm run build`, `pnpm test`).
7. Live test with symlinked data against the §4 compatibility matrix in plan.
8. Swap into main tree via `git reset --hard $UPGRADE_COMMIT`.
9. Restart launchd service. Verify all 26 matrix items.
10. Run `/migrate-nanoclaw` diagnostics.

**Staging:** Apply skills first → validate build → apply host source customizations → validate build → apply container agent-runner code → final build → live test.

**Critical risk:** Container agent-runner (`@gpt`/`@discuss` runtime) lives in `container/agent-runner/src/` and is ~1485 new lines plus ~+86 lines of changes to `index.ts`. v2's agent-runner moved from Node to Bun (per CHANGELOG). Manual review required at every file.

---

## Applied Skills

User confirmed (2026-04-27): the **only active channel is Slack**. Other `add-*` skills are installed in `.claude/skills/` but inactive. Migration prioritizes Slack 100% compatibility.

### Required (apply in worktree)

| Skill | v2 source | Why |
|---|---|---|
| `add-slack` | `channels` branch | The active channel. Replaces v1 hand-written `src/channels/slack.ts` (+369) and `src/channels/slack.test.ts` (+972). |
| `add-reactions` | `channels` branch | Reactions infrastructure — required by Slack reaction status machine (C5). |
| `add-codex` | `providers` branch | Provides v2-standard OpenAI provider scaffolding. We layer WHAM auth on top (see §OpenAI auth decision below). |
| `add-compact` | `channels` branch | `/compact` slash command. |
| `channel-formatting` | local `.claude/skills/` | Project-internal helper. Copy directory directly. |

### Inactive — preserve install but don't validate

These skills are installed in the v1 fork but the user does not actively use them today. Carry them across so reinstating any of them later is a flag flip, not a re-installation:

`add-whatsapp`, `add-telegram`, `add-discord`, `add-gmail`, `add-voice-transcription`, `add-image-vision`, `add-pdf-reader`, `add-telegram-swarm`, `use-local-whisper`

**How to carry across:** rather than running each `/add-*` in the worktree (which would invoke their full install/auth flow), copy the inactive skill directories from v1 `.claude/skills/` into the worktree as-is. Their channel-side source code (e.g. `src/channels/telegram.ts`) ships via the same skill — apply it lazily only if/when the user activates that channel later.

```bash
# After Slack/reactions/codex/compact are in via /add-*, copy inactive skill dirs:
cp -R /Users/pilming/workspace/pilming-claw/.claude/skills/{add-whatsapp,add-telegram,add-discord,add-gmail,add-voice-transcription,add-image-vision,add-pdf-reader,add-telegram-swarm,use-local-whisper} \
      /Users/pilming/workspace/pilming-claw/.upgrade-worktree/.claude/skills/
```

If any of these skill folders contain v1-shaped SKILL.md frontmatter that v2 rejects, prefer the v2 channels-branch version of the same skill folder over the v1 copy (drop the v1 dir and pull from `upstream/channels`).

### Skipped

- `convert-to-apple-container` — system uses Docker.
- `init-onecli` — already done in v1.2.35.
- `update-nanoclaw` — replaced by `migrate-nanoclaw`.

### OpenAI auth decision

User confirmed (2026-04-27): **keep WHAM (ChatGPT subscription) auth** — do not switch to `/add-codex`'s API-key path. Run cost stays subscription-based.

Implication for C9–C11:
- Apply `/add-codex` for the v2 provider abstraction scaffolding (entity model, agent group plumbing, OneCLI vault wiring).
- Layer WHAM-specific code on top: port `openai-auth.ts` (C11) verbatim. In `openai-runner.ts` (C9), keep the WHAM Responses-API + SSE branch and the `detectAuthMode` switch — even if `/add-codex` only exposes API-key, the dual-mode switch lets us flip later without re-porting.

---

## Removed

- `lotto-buy` container skill — explicit user decision (commit `008cbb8`). Do **not** reinstall in v2.

---

## Skill Interactions

- **`add-slack` ↔ `add-reactions`:** the Slack reaction status machine (C5) requires the reactions infrastructure to be present. Apply `add-reactions` before validating C5.
- **`add-codex` ↔ container agent-runner customizations (C9–C11):** `add-codex` provides the v2-standard Codex provider plumbing. Our `@gpt` and `@discuss` paths (WHAM-based, ChatGPT subscription) extend on top of `add-codex`'s OpenAI auth/runner. Confirm whether `add-codex` already covers WHAM auth (`X-Authorization: Bearer ...`) — if it does, drop our `openai-auth.ts` (C11) in favor of the standard. If it covers only API-key auth, our `openai-auth.ts` plugs in alongside.
- **`channel-formatting` ↔ host text-styles (C3, C4):** the host-side `text-styles.ts` formatter is invoked from the outbound delivery path; the `channel-formatting` skill provides agent-side formatting hints that complement it. Both must coexist for Slack/Signal to render correctly.

---

## Customizations

### C1. Pipe-separated alternative triggers

**Intent:** `TRIGGER_WORD` env var supports multiple alternatives separated by `|`, e.g. `@Andy|@Bob`. All listed triggers match (case-insensitive) at the start of a message.

**Files:** `src/config.ts`

**How to apply:** In v2's trigger-pattern builder (likely in `src/config.ts` or a new `src/triggers.ts` module), replace the single-trigger regex construction with:

```typescript
const parts = trigger
  .split('|')
  .map((t) => escapeRegex(t.trim()))
  .filter(Boolean);
const pattern =
  parts.length > 1 ? `^(?:${parts.join('|')})\\b` : `^${parts[0]}\\b`;
return new RegExp(pattern, 'i');
```

`escapeRegex` should escape regex metacharacters (existing helper in v1). If v2 trigger plumbing has changed (e.g. moved into a triggers module), apply the same logic at the equivalent point.

---

### C2. Vendor detection + `@gpt` / `@discuss` trigger patterns

**Intent:** Determine which provider (Claude / OpenAI / Discuss-mode) handles a message based on the first message's prefix.

**Files:** `src/config.ts` (host-side detection), `src/types.ts` (Vendor type), `container/agent-runner/src/index.ts` (vendor switch in agent-runner entry point).

**How to apply:**

1. In v1 `src/types.ts`, vendor type was added:
   ```typescript
   export type Vendor = 'claude' | 'openai' | 'discuss';
   ```
   Add equivalent to v2 `src/types.ts`. v2 provider abstraction (`src/providers/`) may already have a similar type — align names with whatever v2 uses, but the three modes must exist.

2. In v1 `src/config.ts`:
   ```typescript
   export const GPT_TRIGGER_PATTERN = /^@gpt\b/i;
   export const DISCUSS_TRIGGER_PATTERN = /^@discuss\b/i;

   export function isGptTrigger(content: string): boolean {
     return GPT_TRIGGER_PATTERN.test(content.trim());
   }
   export function isDiscussTrigger(content: string): boolean {
     return DISCUSS_TRIGGER_PATTERN.test(content.trim());
   }
   export function detectVendorFromMessages(messages: NewMessage[]): Vendor {
     if (messages.some((m) => isDiscussTrigger(m.content))) return 'discuss';
     return messages.some((m) => isGptTrigger(m.content)) ? 'openai' : 'claude';
   }
   export function generateRequestId(): string {
     return `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
   }
   ```
   Port to v2 `src/config.ts` (or a new `src/triggers.ts`).

3. In v2's host message loop (replacement of v1 `src/index.ts:processGroupMessages`), call `detectVendorFromMessages` on the buffered messages and pass `vendor` plus `requestId` into the agent-runner invocation. v2 may already have a request-id concept — reuse it instead of `generateRequestId` if so.

---

### C3. Channel-aware text formatting (host side)

**Intent:** Convert the agent's Markdown output to each channel's native text syntax before delivery (WhatsApp `*bold*`, Telegram `**bold**`, Slack `*bold*` + `<url|text>` links + aligned code-block tables, Signal passthrough — see C4).

**Files:** `src/text-styles.ts` (entire file — +337 lines after C3 + C4 + Slack table conversion are merged), `src/index.ts` (call site).

**How to apply:**

1. Copy `src/text-styles.ts` from v1 verbatim into v2 at the equivalent path. Key exported function:
   ```typescript
   export function parseTextStyles(text: string, channel: ChannelType): string
   ```
   And the small wrapper expected by callers (`formatOutbound`) that strips `<internal>...</internal>` tags first then calls `parseTextStyles`.

2. The Slack-only branch invokes `convertMarkdownTablesForSlack(text)` before segmentation — converts `| col | col |` markdown tables to fenced code blocks with column padding by visual width (CJK = 2 cells, ASCII = 1, emoji = 2). Function lives in the same file (~110 lines from `TABLE_SEPARATOR_RE` to end of `convertMarkdownTablesForSlack`).

3. Wire into v2's outbound path. v2's `src/router.ts` and/or `src/delivery.ts` is where the agent's stringified result is sent to a channel. Wrap the raw text with:
   ```typescript
   const text = formatOutbound(raw, channel.name as ChannelType);
   ```
   In v1 this happens in `src/index.ts` inside the `runAgent` streaming callback; in v2 it should happen at the equivalent point in delivery.

4. Discord and Signal are passthrough at the `parseTextStyles` level (`if (channel === 'discord' || channel === 'signal') return text;`). Signal rich text is handled separately via `parseSignalStyles` (see C4).

---

### C4. Signal rich-text styles (host side)

**Intent:** Signal's signal-cli accepts a `textStyle` parameter — array of `{start, length, style}` ranges in UTF-16 offsets. Convert Markdown bold/italic/strikethrough/monospace/spoiler to Signal textStyle ranges, return plain text + style array.

**Files:** `src/text-styles.ts` (lines 51–230 area — `SignalTextStyle` interface, `parseSignalStyles` function, helper segments).

**How to apply:**

1. Copy `SignalTextStyle` interface and `parseSignalStyles` function from v1 `src/text-styles.ts:51–230` verbatim. The interface shape:
   ```typescript
   export interface SignalTextStyle {
     start: number;
     length: number;
     style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
   }
   export function parseSignalStyles(rawText: string): {
     text: string;
     textStyle: SignalTextStyle[];
   }
   ```

2. The Signal channel adapter (`src/channels/signal.ts` or v2's equivalent) must call `parseSignalStyles(text)` and pass the resulting `textStyle` array to signal-cli's send method. v1 signal channel was added via `add-signal` skill (or directly by user). If v2 has `/add-signal`, check whether it already forwards `textStyle`; if not, patch the adapter.

3. Helper functions used by `parseSignalStyles`: search for `Segment` interface and helpers near line 255–end.

---

### C5. Slack reaction state machine

**Intent:** When a user pings the agent in Slack, react to the trigger message with `:hourglass_flowing_sand:` while processing, swap to `:white_check_mark:` on success, leave at hourglass (or no reaction) on failure. Provides a passive "agent is working / done" indicator without sending extra messages.

**Files:** `src/index.ts` (lines ~78–100, ~280–320), depends on `addReaction`/`removeReaction` channel methods (provided by `add-reactions` skill).

**How to apply:**

1. Module-level state (in v2's host orchestrator, equivalent of v1 `src/index.ts`):
   ```typescript
   // Maps chatJid → triggerMsgId awaiting reaction settlement.
   // Shared between processGroupMessages (callback settles) and startMessageLoop (piping sets).
   const pendingReactions = new Map<string, string>();
   ```

2. Before invoking the agent in the per-group handler:
   ```typescript
   await channel.setTyping?.(chatJid, true);
   pendingReactions.set(chatJid, triggerMsgId);
   await channel.addReaction?.(chatJid, triggerMsgId, 'hourglass_flowing_sand');
   ```

3. Settlement function (closed over channel + chatJid):
   ```typescript
   const settleReaction = async (success: boolean) => {
     const msgId = pendingReactions.get(chatJid);
     if (!msgId) return;
     pendingReactions.delete(chatJid);
     await channel.removeReaction?.(chatJid, msgId, 'hourglass_flowing_sand');
     if (success) {
       await channel.addReaction?.(chatJid, msgId, 'white_check_mark');
     }
   };
   ```
   Call `settleReaction(true)` after `runAgent` returns successfully, `settleReaction(false)` on error.

4. Piping-to-running-session case: when `startMessageLoop` pipes a follow-up message into an active session, it must `pendingReactions.set(chatJid, newTriggerMsgId)` so the in-flight `settleReaction` settles the latest trigger, not the old one. v1 has a `pipedTriggerMsgId` flow around line 280–295 — port it.

5. The optional-chaining (`?.()`) on `addReaction`/`removeReaction` is intentional: only Slack provides them in v1. Other channels silently no-op.

---

### C6. `runAgent` interface extension (host side)

**Intent:** Carry `vendor`, `requestId`, and richer `ContainerOutput` metadata (model, effort, usage, cost, duration, numTurns) through the agent invocation.

**Files:** `src/container-runner.ts`.

**How to apply:**

In v1 `src/container-runner.ts`:
- `ContainerOutput` interface adds: `model?`, `effort?`, `usage?`, `costUSD?`, `durationMs?`, `numTurns?`.
- `runAgent` signature gains `requestId: string`, `vendor: Vendor` parameters; passes them through to the container as part of `ContainerInput`.
- The streaming callback (`onOutput`) receives the extended `ContainerOutput`.

v2's container runner has been refactored — first read v2's current signature, then add the missing parameters and metadata fields. Also propagate `vendor` into the container-input JSON written to stdin.

---

### C7. Container runtime retry at boot

**Intent:** On host startup, the container runtime (Docker daemon or Apple Container) may not be ready yet. Retry the runtime check with backoff for up to 90 seconds before failing.

**Files:** `src/container-runtime.ts`.

**How to apply:** Compare v1 `src/container-runtime.ts` `+91 / -41` lines vs v2's `src/container-runtime.ts`. v2 also has a fix branch (`upstream/fix/container-restart-recovery`) that touches this area. **Confirm whether v2's main already includes equivalent retry logic before porting our changes** — do not double-apply. If v2 does retry-on-boot already, drop ours and adopt theirs.

---

### C8. IPC `send_file` — agent-initiated file delivery to channel

**Intent:** Agent (running in container) writes a file to `/workspace/group/<rel>` or `/workspace/ipc/<rel>`, then drops an IPC message `{type: "send_file", chatJid, containerPath, filename?, comment?}`. Host receives the IPC, validates the path is under the allowed prefix and does not escape via symlinks, then sends the file to the channel.

**Files:** `src/ipc.ts` (lines ~104–174 — message type handler), depends on host helpers `resolveGroupFolderPath`, `resolveGroupIpcPath`, and channel `sendFile` capability.

**How to apply:**

1. v2's IPC mechanism has been restructured (v1 `src/ipc.ts` deleted upstream, replaced by a different host↔container channel — likely the inbound/outbound DBs from the v2 BREAKING change). Read v2 `docs/api-details.md` and `docs/db-session.md` to understand the new IPC.

2. Add a `send_file` message type handler to v2's IPC:
   - Authorization: only the source group's container, or the main group, may target a given chatJid.
   - Path validation:
     ```typescript
     if (containerPath.startsWith('/workspace/group/')) {
       const relPath = containerPath.slice('/workspace/group/'.length);
       const groupBase = resolveGroupFolderPath(sourceGroup);
       const resolved = path.resolve(groupBase, relPath);
       const rel = path.relative(groupBase, resolved);
       if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
         hostPath = resolved;
       }
     } else if (containerPath.startsWith('/workspace/ipc/')) {
       // same pattern with resolveGroupIpcPath
     }
     ```
   - Reject everything else (logger.warn).
   - Existence check: `fs.existsSync(hostPath)` before sending.
   - Delegate to `deps.sendFile(chatJid, hostPath, { filename, comment })`.
   - Always `fs.unlinkSync(filePath)` on the IPC marker file at the end.

3. The container agent emits the IPC message via the agent-runner's IPC stdio (see `container/agent-runner/src/ipc-mcp-stdio.ts` modifications).

4. v2's `src/modules/mount-security/` may already enforce equivalent path restrictions — leverage rather than duplicate. Specifically: if v2 already validates mount-relative paths from container, our path-prefix logic above is the **policy**; v2's mount-security is the **mechanism**.

---

### C9. ⭐ OpenAI runner (container agent-runner) — `@gpt` runtime

**Intent:** When `vendor === 'openai'`, the agent-runner inside the container calls OpenAI's Responses API (or Chat Completions API) directly via WHAM (ChatGPT subscription) auth or API-key auth, runs a tool-use loop, and writes back `ContainerOutput` results.

**Files:** `container/agent-runner/src/openai-runner.ts` (NEW, 787 lines in v1).

**How to apply:**

This is **the largest single piece of new code** in the migration (787 lines). It cannot be fully reproduced from a brief description — the v2 implementation must reference v1 source directly.

Key entry points and helpers (from v1):

```typescript
export async function runOpenAI(containerInput: ContainerInput): Promise<void>
export async function callGptSimple(...)  // simple one-shot

// Internal:
function detectAuthMode(): AuthMode  // 'wham' | 'apikey'
async function callChatCompletions(...)
async function runChatCompletionsLoop(...)
function extractText(item: ResponsesOutputItem): string | undefined
const WHAM_BASE_URL = 'https://chatgpt.com/backend-api/wham'
function parseSSEEvents(...)
async function callResponsesAPI(...)
function outputToInput(output: ResponsesOutputItem[]): ResponsesInputItem[]
async function runResponsesLoop(...)
```

Implementation steps:

1. **First check whether `/add-codex` already provides WHAM/Responses-API support.** v2 ships `add-codex` via the providers branch. Read `.claude/skills/add-codex/SKILL.md` and the resulting `container/agent-runner/src/providers/codex.ts` after applying. If it already covers our use case (WHAM auth + Responses API streaming + tool loop), **do not port our `openai-runner.ts`** — adopt the standard.

2. If `add-codex` covers only API-key auth, port WHAM-specific bits from our `openai-runner.ts` (`detectAuthMode`, WHAM headers, SSE parsing for the WHAM endpoint). Layer them on top of `add-codex`'s API-key path so users on either auth mode work.

3. v2's agent-runner is now Bun-based (per CHANGELOG `Agent-runner runtime moved from Node to Bun`). Most TypeScript code ports cleanly; watch for Node-specific imports (`fs/promises`, etc. — Bun supports them but check). The fetch API is identical.

4. Tool-use loop must call into v2's standardized tool registry (`container/agent-runner/src/tools.ts` — also new in v1, see C12). v2 likely has its own tool registration; adapt the loop to dispatch through it.

5. Output: every tool-result + final assistant message must be wrapped in v1's `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` framing so the host can stream. v2 may have changed framing — check `container/agent-runner/src/index.ts` shared helpers.

**Reference v1 source:** `/Users/pilming/workspace/pilming-claw/container/agent-runner/src/openai-runner.ts` (read directly during implementation).

---

### C10. ⭐ Discuss runner (container agent-runner) — `@discuss` runtime

**Intent:** `@discuss <topic>` triggers a multi-round debate between Claude Opus and OpenAI GPT, capped at `MAX_ROUNDS` rounds, with consensus detection (`[CONSENSUS]` tag), conclusion generation, and archive-to-disk on completion. Recent debates are loaded into the agent's context on subsequent runs (via `getRecentDiscussions` in `system-prompt.ts`).

**Files:** `container/agent-runner/src/discuss-runner.ts` (NEW, 521 lines).

**How to apply:**

521 lines — must reference v1 source during implementation. Key entry/helpers:

```typescript
const CLAUDE_MODEL = process.env.DISCUSS_CLAUDE_MODEL || 'claude-opus-4-7';
const CLAUDE_EFFORT = 'max';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4';
const OPENAI_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'xhigh';
const MAX_ROUNDS = parseInt(process.env.DISCUSS_MAX_ROUNDS || '7', 10);
const CONSENSUS_TAG = '[CONSENSUS]';
const DISCUSS_TRIGGER = /^@discuss\s*/i;
const DISCUSS_INDEX_MAX_ENTRIES = 10;
const DISCUSS_EXPIRY_DAYS = 10;

export async function runDiscuss(containerInput: ContainerInput): Promise<void>

// Helpers:
function extractTopicFromPrompt(prompt: string): string
function buildClaudeSystemPrompt(topic: string): string
function buildGptSystemPrompt(topic: string): string
async function callClaude(...)
async function callGpt(system: string, prompt: string): Promise<string>
function buildClaudePrompt(history, topic, round): string
function buildGptPrompt(topic, history, round): string
function hasConsensus(text: string): boolean
function checkUserIntervention(history): void
async function generateConclusion(...)
function archiveDebate(topic, history, conclusion?): string | undefined
function updateDiscussIndex(topic, history, conclusion?, archiveFilename?): void
function cleanupExpiredDebates(): void
async function runDebate(topic: string): Promise<void>
```

Implementation steps:

1. Port the file as-is to v2 agent-runner. Adapt imports (some helpers from `shared.ts`, `system-prompt.ts`).
2. `callClaude` invokes the Claude SDK (`@anthropic-ai/claude-agent-sdk`) with `model: CLAUDE_MODEL`, `extra_thinking: { type: 'enabled', budget_tokens: <max> }`. v2's SDK version may differ — confirm thinking parameter name.
3. `callGpt` reuses the OpenAI runner from C9. Effort `xhigh` maps to OpenAI Responses API `reasoning.effort = 'xhigh'`.
4. Archive directory: `groups/<group>/discussions/` — debate JSON + index file. v2 group folder layout may have moved (see v2 `src/group-folder.ts`); adapt path resolution.
5. `cleanupExpiredDebates` runs on each invocation, deletes archives older than 10 days.
6. `getRecentDiscussions` (in `system-prompt.ts`) loads last N debate summaries into Claude's system prompt for context continuity (see C12 below).

**Reference v1 source:** `/Users/pilming/workspace/pilming-claw/container/agent-runner/src/discuss-runner.ts` and related `system-prompt.ts:getRecentDiscussions`.

---

### C11. OpenAI auth (WHAM) — `openai-auth.ts`

**Intent:** Authenticate against OpenAI's WHAM endpoint using a ChatGPT subscription token, with token refresh handling. Provides a `getOpenAIAuth()` helper used by the OpenAI runner (C9) and Discuss runner (C10).

**Files:** `container/agent-runner/src/openai-auth.ts` (NEW, 177 lines).

**How to apply:**

1. **Check `/add-codex` first.** If the v2 Codex skill ships its own WHAM auth or the user is willing to switch to API-key auth, drop our `openai-auth.ts`.

2. If keeping WHAM: port the file as-is. Key responsibilities:
   - Read auth token from OneCLI vault (v2: via vault; v1: via env or auth file).
   - Detect token expiry from JWT `exp` claim, refresh as needed.
   - Provide `Authorization: Bearer <token>` header for WHAM HTTP calls.
3. v2's OneCLI integration is more formalized — fetch token via OneCLI's per-agent secret API rather than reading env directly.

**Reference v1 source:** `/Users/pilming/workspace/pilming-claw/container/agent-runner/src/openai-auth.ts`.

---

### C12. Container agent-runner — supporting modules

**Intent:** v1 split the agent-runner monolith into modules: `shared.ts` (utilities), `system-prompt.ts` (Claude system prompt + recent-discussions context loader), `tools.ts` (tool registry).

**Files:**
- `container/agent-runner/src/shared.ts` (NEW, 289 lines) — IPC helpers, transcript parsing, file naming.
- `container/agent-runner/src/system-prompt.ts` (NEW, 111 lines) — `getGlobalClaudeMd`, `getExtraDirectories`, `getRecentDiscussions`.
- `container/agent-runner/src/tools.ts` (NEW, 685 lines) — agent tool registry.
- `container/agent-runner/src/index.ts` (MOD, +362/-276) — entry point that dispatches to `runClaude`, `runOpenAI`, `runDiscuss` based on `containerInput.vendor`.
- `container/agent-runner/src/ipc-mcp-stdio.ts` (MOD, +46) — IPC stdio for sending file/typing events.

**How to apply:**

1. v2 likely has its own modular layout. Read v2's current `container/agent-runner/src/` first.

2. **`shared.ts`:** Port helpers if v2 doesn't have equivalents. Key exports: `writeOutput`, `log`, `readStdin`, `shouldClose`, `drainIpcInput`, `waitForIpcMessage`, `runScript`, `parseTranscript`, `formatTranscriptMarkdown`, `sanitizeFilename`, `generateFallbackName`, plus IPC constants `IPC_INPUT_DIR`, `IPC_INPUT_CLOSE_SENTINEL`, `IPC_POLL_MS`. Many of these may already exist in v2 — diff and merge.

3. **`system-prompt.ts`:** `getRecentDiscussions(groupName)` loads the last N debates from `groups/<group>/discussions/index.json`. Required by the discuss-runner archive flow (C10). Other helpers may already be in v2.

4. **`tools.ts`:** Tool registry — agent tools the runner exposes. Cross-reference with v2's tool-loading mechanism (Bun-based agent-runner may use a different registration pattern).

5. **`index.ts`:** Dispatch entry point. v1 logic:
   ```typescript
   if (containerInput.vendor === 'openai') return runOpenAI(containerInput);
   if (containerInput.vendor === 'discuss') return runDiscuss(containerInput);
   return runClaude(containerInput);  // default
   ```
   v2's agent-runner index has been refactored heavily — port this dispatch into v2's equivalent entry point.

6. **`ipc-mcp-stdio.ts`:** +46 lines for `send_file` IPC (counterpart of host C8). Container side: agent calls `sendFile({ chatJid, containerPath, filename, comment })` → tool emits IPC marker file under `/workspace/ipc/output/`.

**Reference v1 source:** all five files under `/Users/pilming/workspace/pilming-claw/container/agent-runner/src/`.

---

### C13. In-tree container skills (`container/skills/`)

**Intent:** Custom container skills the user has authored or installed. These are SKILL.md + supporting code, loaded into the agent's context when the trigger phrase matches.

**Files:** `container/skills/{kma-weather, naver-calendar, kakao-map, blog-draft, pilming-brain-draft, slack-formatting}/`.

**How to apply:**

1. Copy each directory verbatim from v1 to v2:
   ```bash
   cp -R /Users/pilming/workspace/pilming-claw/container/skills/{kma-weather,naver-calendar,kakao-map,blog-draft,pilming-brain-draft,slack-formatting} \
         /Users/pilming/workspace/pilming-claw/.upgrade-worktree/container/skills/
   ```

2. **Per-skill compatibility check:**
   - `kma-weather` (b60cb3c, dd45d7f): pure HTTP fetch + parse. Should work unchanged. Verify retry/web-search-fallback logic still loads agent tools the same way.
   - `naver-calendar` (5b8b977): CalDAV. Verify TLS/proxy behavior under Bun (if v2 agent-runner is Bun, fetch + tls should be drop-in but worth a smoke test).
   - `kakao-map` (c26ccf9): includes NO_PROXY consolidation — verify v2's OneCLI proxy injection respects NO_PROXY for kakao endpoints.
   - `blog-draft` (202d8d7): SKILL.md is auth-agnostic per commit message. Should work.
   - `pilming-brain-draft` (479940c): thought-logging into a per-group file. Verify group-folder path resolution under v2's group layout.
   - `slack-formatting` (with table conversion): verify Slack channel forwards messages through the host-side `formatOutbound` (C3) — if so, this skill is mostly hint text for the agent.

3. **Do NOT copy** `container/skills/lotto-buy/` — explicitly removed (commit `008cbb8`).

4. v2 may also ship its own container skills (`agent-browser`, `capabilities`, `file-upload`, `status` were present in v1 — confirm whether these are user-added or upstream. If upstream, do not duplicate).

---

### C14. Custom host skills (`.claude/skills/`)

**Intent:** Host-side skills installed via `/add-*` (most) or authored locally (`channel-formatting`).

**Files:** see Applied Skills table at top.

**How to apply:** apply via the `/add-<name>` skill in the worktree (covered by Applied Skills section). For `channel-formatting` (project-internal helper not on a v2 branch), copy the directory directly:
```bash
cp -R /Users/pilming/workspace/pilming-claw/.claude/skills/channel-formatting \
      /Users/pilming/workspace/pilming-claw/.upgrade-worktree/.claude/skills/
```

---

### C15. `.env.example` additions

**Intent:** New environment variables introduced by Slack and OpenAI integrations.

**Files:** `.env.example`.

**How to apply:** Add the following entries to v2's `.env.example` (or equivalent — v2 may move env to `config-examples/`):
```
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=

# Shared OpenAI settings for @gpt and @discuss triggers
OPENAI_MODEL=gpt-5.4
OPENAI_REASONING_EFFORT=xhigh
```

Real values live in OneCLI vault, not in `.env`. If `/add-slack` and `/add-codex` add their own variants of these keys, prefer theirs — only add what's missing.

---

### C16. `groups/global/CLAUDE.md` persona/instruction edits

**Intent:** User-level persona, behavioral guidance, and global instructions that apply to every agent group.

**Files:** `groups/global/CLAUDE.md` (+19 / -2 lines from base).

**How to apply:** Copy the v1 `groups/global/CLAUDE.md` into v2 verbatim. v2 may have a different `groups/` layout (per CHANGELOG: "composed CLAUDE.md = shared base + per-group fragments"), so:
1. Read v2's `groups/global/CLAUDE.md` (or whatever the new shared-base file is).
2. Diff against v1's `groups/global/CLAUDE.md`.
3. Merge user-authored sections (the +19 lines) into v2's structure.

---

## Modifications to Applied Skills

(None — the user did not modify the contents of any upstream skill branch in place. All non-skill changes are captured under Customizations above.)

---

## Validation Checklist

Tracked in `/Users/pilming/.claude/plans/lexical-juggling-teapot.md` §4 (Compatibility Matrix, 26 items). Every item must pass before swap into main tree.

---

## Reference Hashes

- v1 base (merge-base with upstream/main): `4383e3e`
- v1 HEAD at guide generation: `2768192`
- v2 upstream/main HEAD: `f8c3d02`
- Backup tag (origin): `pre-v2-migration-2768192-20260427-131755`
- Backup branch (origin): `backup/pre-v2-migration-2768192-20260427-131755`
