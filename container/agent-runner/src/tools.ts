/**
 * Tool definitions and executors for the OpenAI agent runner.
 * Implements the same tools available in Claude Agent SDK for feature parity.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// --- IPC helpers (replicate MCP server logic for OpenAI runner) ---

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// --- Types ---

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

// --- Tool definitions (OpenAI function calling format) ---

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a bash command and return its output. Use this for running shell commands, scripts, git operations, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description:
              'Optional timeout in milliseconds (default: 120000, max: 600000)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file. Returns the file content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to read',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-based)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read (default: 2000)',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating it if it does not exist or overwriting if it does.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit a file by replacing an exact string match with new content. The old_string must be unique in the file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to find and replace',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false)',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files matching a glob pattern. Returns matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'Glob pattern to match (e.g., "**/*.ts", "src/**/*.js")',
          },
          path: {
            type: 'string',
            description:
              'Directory to search in (default: current working directory)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents for a regex pattern. Returns matching lines with context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for',
          },
          path: {
            type: 'string',
            description: 'File or directory to search in (default: cwd)',
          },
          glob: {
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "*.ts")',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case insensitive search (default: false)',
          },
          context: {
            type: 'number',
            description: 'Lines of context around each match',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the contents of a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages.",
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The message text to send',
          },
          sender: {
            type: 'string',
            description:
              'Your role/identity name (e.g., "Researcher"). Optional.',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description: 'Upload a file to the user or group.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file inside the container',
          },
          filename: {
            type: 'string',
            description: 'Display filename for the upload',
          },
          comment: {
            type: 'string',
            description: 'Optional caption/comment for the file',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What the agent should do when the task runs',
          },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description: 'cron=recurring, interval=every N ms, once=one-time',
          },
          schedule_value: {
            type: 'string',
            description:
              'cron: "*/5 * * * *" | interval: "300000" | once: "2026-02-01T15:30:00"',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
            description:
              'group=with chat history, isolated=fresh session (default: group)',
          },
          vendor: {
            type: 'string',
            enum: ['claude', 'openai'],
            description:
              'Which LLM vendor to use for this task (default: claude)',
          },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all scheduled tasks for this group.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

// --- Responses API tool format (for WHAM subscription mode) ---

export interface ResponsesToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: object;
}

/**
 * Convert Chat Completions tool definitions to Responses API format.
 * Responses API uses a flat structure (no `function` wrapper).
 */
export function responsesToolDefinitions(): ResponsesToolDef[] {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function' as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

// --- Tool executors ---

const BASH_TIMEOUT = 120_000;
const BASH_MAX_BUFFER = 1024 * 1024;
const READ_DEFAULT_LIMIT = 2000;

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ipcContext: { chatJid: string; groupFolder: string; isMain: boolean },
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'bash':
        return executeBash(args);
      case 'read_file':
        return executeReadFile(args);
      case 'write_file':
        return executeWriteFile(args);
      case 'edit_file':
        return executeEditFile(args);
      case 'glob':
        return executeGlob(args);
      case 'grep':
        return executeGrep(args);
      case 'web_fetch':
        return await executeWebFetch(args);
      case 'send_message':
        return executeSendMessage(args, ipcContext);
      case 'send_file':
        return executeSendFile(args, ipcContext);
      case 'schedule_task':
        return executeScheduleTask(args, ipcContext);
      case 'list_tasks':
        return executeListTasks();
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      output: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeBash(args: Record<string, unknown>): ToolResult {
  const command = args.command as string;
  const timeout = Math.min(
    (args.timeout as number) || BASH_TIMEOUT,
    600_000,
  );

  try {
    const output = execSync(command, {
      timeout,
      maxBuffer: BASH_MAX_BUFFER,
      encoding: 'utf-8',
      cwd: '/workspace/group',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: output || '(no output)' };
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message: string;
    };
    const stdout = execErr.stdout || '';
    const stderr = execErr.stderr || '';
    return {
      output: `Exit code: ${execErr.status || 1}\nStdout: ${stdout}\nStderr: ${stderr}`,
      isError: true,
    };
  }
}

function executeReadFile(args: Record<string, unknown>): ToolResult {
  const filePath = args.file_path as string;
  const offset = ((args.offset as number) || 1) - 1; // Convert to 0-based
  const limit = (args.limit as number) || READ_DEFAULT_LIMIT;

  if (!fs.existsSync(filePath)) {
    return { output: `File not found: ${filePath}`, isError: true };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice.map(
    (line, i) => `${offset + i + 1}\t${line}`,
  );
  return { output: numbered.join('\n') };
}

function executeWriteFile(args: Record<string, unknown>): ToolResult {
  const filePath = args.file_path as string;
  const content = args.content as string;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
  return { output: `File written: ${filePath}` };
}

function executeEditFile(args: Record<string, unknown>): ToolResult {
  const filePath = args.file_path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) || false;

  if (!fs.existsSync(filePath)) {
    return { output: `File not found: ${filePath}`, isError: true };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (!content.includes(oldString)) {
    return {
      output: `old_string not found in ${filePath}. Make sure the string matches exactly.`,
      isError: true,
    };
  }

  if (!replaceAll) {
    // Check uniqueness
    const firstIdx = content.indexOf(oldString);
    const secondIdx = content.indexOf(oldString, firstIdx + 1);
    if (secondIdx !== -1) {
      return {
        output: `old_string is not unique in ${filePath}. Provide more context or use replace_all.`,
        isError: true,
      };
    }
    content = content.replace(oldString, newString);
  } else {
    content = content.split(oldString).join(newString);
  }

  fs.writeFileSync(filePath, content);
  return { output: `File edited: ${filePath}` };
}

function executeGlob(args: Record<string, unknown>): ToolResult {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || '/workspace/group';

  try {
    // Use find with shell globbing via bash
    const output = execSync(
      `find ${JSON.stringify(searchPath)} -path ${JSON.stringify(pattern)} -o -name ${JSON.stringify(pattern)} 2>/dev/null | head -200`,
      {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: BASH_MAX_BUFFER,
        cwd: searchPath,
      },
    );

    if (!output.trim()) {
      // Fallback: try using bash globbing
      const globOutput = execSync(
        `shopt -s globstar nullglob && cd ${JSON.stringify(searchPath)} && ls -d ${pattern} 2>/dev/null | head -200`,
        {
          encoding: 'utf-8',
          timeout: 10_000,
          maxBuffer: BASH_MAX_BUFFER,
          shell: '/bin/bash',
        },
      );
      return { output: globOutput.trim() || 'No matches found.' };
    }

    return { output: output.trim() };
  } catch {
    return { output: 'No matches found.' };
  }
}

function executeGrep(args: Record<string, unknown>): ToolResult {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || '/workspace/group';
  const globFilter = args.glob as string | undefined;
  const caseInsensitive = args.case_insensitive as boolean | undefined;
  const context = args.context as number | undefined;

  // Use ripgrep (rg) for better performance, fall back to grep
  const rgArgs: string[] = ['-n'];
  if (caseInsensitive) rgArgs.push('-i');
  if (context) rgArgs.push(`-C${context}`);
  if (globFilter) rgArgs.push(`--glob`, globFilter);
  rgArgs.push(pattern, searchPath);

  try {
    const output = execSync(
      `rg ${rgArgs.map((a) => JSON.stringify(a)).join(' ')} 2>/dev/null | head -200`,
      {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: BASH_MAX_BUFFER,
        shell: '/bin/bash',
      },
    );
    return { output: output.trim() || 'No matches found.' };
  } catch {
    return { output: 'No matches found.' };
  }
}

async function executeWebFetch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = args.url as string;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NanoClaw-Agent/1.0' },
      signal: AbortSignal.timeout(30_000),
    });

    const contentType = response.headers.get('content-type') || '';
    if (
      contentType.includes('text') ||
      contentType.includes('json') ||
      contentType.includes('xml')
    ) {
      const text = await response.text();
      // Truncate large responses
      const maxLen = 50_000;
      return {
        output:
          text.length > maxLen ? text.slice(0, maxLen) + '\n...(truncated)' : text,
      };
    } else {
      return {
        output: `Fetched ${url} (${response.status}). Content-Type: ${contentType}. Binary content not displayed.`,
      };
    }
  } catch (err) {
    return {
      output: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeSendMessage(
  args: Record<string, unknown>,
  ctx: { chatJid: string; groupFolder: string },
): ToolResult {
  const text = args.text as string;
  const sender = args.sender as string | undefined;

  const data: Record<string, string | undefined> = {
    type: 'message',
    chatJid: ctx.chatJid,
    text,
    sender,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(MESSAGES_DIR, data);
  return { output: 'Message sent.' };
}

function executeSendFile(
  args: Record<string, unknown>,
  ctx: { chatJid: string },
): ToolResult {
  const filePath = args.file_path as string;
  const filename = args.filename as string | undefined;
  const comment = args.comment as string | undefined;

  if (!fs.existsSync(filePath)) {
    return { output: `File not found: ${filePath}`, isError: true };
  }

  const data = {
    type: 'send_file',
    chatJid: ctx.chatJid,
    containerPath: filePath,
    filename: filename || path.basename(filePath),
    comment,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(MESSAGES_DIR, data);
  return { output: `File upload queued: ${filePath}` };
}

function executeScheduleTask(
  args: Record<string, unknown>,
  ctx: { chatJid: string; groupFolder: string; isMain: boolean },
): ToolResult {
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetJid = ctx.chatJid;

  const data = {
    type: 'schedule_task',
    taskId,
    prompt: args.prompt as string,
    schedule_type: args.schedule_type as string,
    schedule_value: args.schedule_value as string,
    context_mode: (args.context_mode as string) || 'group',
    vendor: (args.vendor as string) || 'openai',
    targetJid,
    createdBy: ctx.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile(TASKS_DIR, data);
  return {
    output: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
  };
}

function executeListTasks(): ToolResult {
  const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

  try {
    if (!fs.existsSync(tasksFile)) {
      return { output: 'No scheduled tasks found.' };
    }
    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    return { output: JSON.stringify(tasks, null, 2) };
  } catch (err) {
    return {
      output: `Failed to read tasks: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
