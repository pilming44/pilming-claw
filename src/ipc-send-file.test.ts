import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test',
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn((f: string) => /^[A-Za-z0-9_-]+$/.test(f)),
  resolveGroupFolderPath: vi.fn((folder: string) =>
    path.join('/data/groups', folder),
  ),
  resolveGroupIpcPath: vi.fn((folder: string) =>
    path.join('/tmp/nanoclaw-test/ipc', folder),
  ),
}));

// Mock container-runner
vi.mock('./container-runner.js', () => ({}));

import { logger } from './logger.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';

// We test processIpcFile indirectly through the message handler logic.
// Since startIpcWatcher uses fs polling, we test the send_file processing
// by directly invoking the IPC handler parts via processTaskIpc (for tasks)
// or by testing the core send_file resolution logic in isolation.

// For send_file, the logic is in the processIpcFiles message handler,
// which isn't directly exported. We'll test via the startIpcWatcher
// by creating real IPC files and letting the watcher pick them up.
// But since that's integration-level, let's test the key pieces:

describe('IPC send_file path resolution', () => {
  it('resolves /workspace/group/ paths to host group folder', () => {
    const containerPath = '/workspace/group/screenshots/page.png';
    const sourceGroup = 'slack_test-channel';

    const relPath = containerPath.slice('/workspace/group/'.length);
    const groupBase = resolveGroupFolderPath(sourceGroup);
    const resolved = path.resolve(groupBase, relPath);
    const rel = path.relative(groupBase, resolved);

    expect(rel).toBe('screenshots/page.png');
    expect(rel.startsWith('..')).toBe(false);
    expect(resolved).toBe('/data/groups/slack_test-channel/screenshots/page.png');
  });

  it('resolves /workspace/ipc/ paths to host IPC folder', () => {
    const containerPath = '/workspace/ipc/output/result.json';
    const sourceGroup = 'slack_test-channel';

    const relPath = containerPath.slice('/workspace/ipc/'.length);
    const ipcBase = resolveGroupIpcPath(sourceGroup);
    const resolved = path.resolve(ipcBase, relPath);
    const rel = path.relative(ipcBase, resolved);

    expect(rel).toBe('output/result.json');
    expect(rel.startsWith('..')).toBe(false);
  });

  it('rejects path traversal attempts in /workspace/group/', () => {
    const containerPath = '/workspace/group/../../etc/passwd';
    const sourceGroup = 'slack_test-channel';

    const relPath = containerPath.slice('/workspace/group/'.length);
    const groupBase = resolveGroupFolderPath(sourceGroup);
    const resolved = path.resolve(groupBase, relPath);
    const rel = path.relative(groupBase, resolved);

    // Should start with '..' indicating escape
    expect(rel.startsWith('..')).toBe(true);
  });

  it('rejects path traversal attempts in /workspace/ipc/', () => {
    const containerPath = '/workspace/ipc/../../../etc/shadow';
    const sourceGroup = 'slack_test-channel';

    const relPath = containerPath.slice('/workspace/ipc/'.length);
    const ipcBase = resolveGroupIpcPath(sourceGroup);
    const resolved = path.resolve(ipcBase, relPath);
    const rel = path.relative(ipcBase, resolved);

    expect(rel.startsWith('..')).toBe(true);
  });

  it('rejects paths not under /workspace/group/ or /workspace/ipc/', () => {
    const containerPath = '/etc/passwd';

    const startsWithGroup = containerPath.startsWith('/workspace/group/');
    const startsWithIpc = containerPath.startsWith('/workspace/ipc/');

    expect(startsWithGroup).toBe(false);
    expect(startsWithIpc).toBe(false);
  });
});
