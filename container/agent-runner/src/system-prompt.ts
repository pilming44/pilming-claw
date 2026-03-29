/**
 * System prompt builder for NanoClaw agent runners.
 * Reads CLAUDE.md files from workspace directories and combines them into a system prompt.
 * Shared between Claude and OpenAI runners.
 */

import fs from 'fs';
import path from 'path';
import { log } from './shared.js';
import type { ContainerInput } from './shared.js';

/**
 * Build a system prompt from CLAUDE.md files in the workspace.
 * - /workspace/group/CLAUDE.md — per-group instructions (always loaded)
 * - /workspace/global/CLAUDE.md — shared instructions (non-main groups only)
 * - /workspace/extra/{name}/CLAUDE.md — additional directory instructions
 */
export function buildSystemPrompt(containerInput: ContainerInput): string {
  const parts: string[] = [];

  // Group-level CLAUDE.md (primary instructions)
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Global CLAUDE.md (shared across non-main groups)
  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
    }
  }

  // Additional directories mounted at /workspace/extra/*
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      const extraClaudeMd = path.join(fullPath, 'CLAUDE.md');
      if (fs.existsSync(extraClaudeMd)) {
        parts.push(fs.readFileSync(extraClaudeMd, 'utf-8'));
        log(`Loaded additional CLAUDE.md from ${fullPath}`);
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Get the global CLAUDE.md content for Claude SDK's systemPrompt.append.
 * Returns undefined if not applicable (main group or file doesn't exist).
 */
export function getGlobalClaudeMd(
  containerInput: ContainerInput,
): string | undefined {
  if (containerInput.isMain) return undefined;
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalClaudeMdPath)) {
    return fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  return undefined;
}

/**
 * Discover additional directories mounted at /workspace/extra/*.
 * These are passed to the Claude SDK so their CLAUDE.md files are loaded automatically.
 */
export function getExtraDirectories(): string[] {
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }
  return extraDirs;
}
