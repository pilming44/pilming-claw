/**
 * OpenAI OAuth token manager for NanoClaw container agent.
 * Loads, refreshes, and provides auth headers for WHAM Responses API.
 */

import fs from 'fs';
import { log } from './shared.js';

// --- Constants ---

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_FILE = '/workspace/auth/openai-oauth.json';
const SAFETY_MARGIN_MS = 30_000; // Refresh 30s before expiry

// --- Types ---

export interface OAuthData {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number; // Unix timestamp in milliseconds
  accountId: string;
}

// --- Token management ---

let cachedTokens: OAuthData | null = null;

/**
 * Load OAuth tokens from the mounted file.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadOAuthTokens(): OAuthData | null {
  if (cachedTokens) return cachedTokens;

  if (!fs.existsSync(OAUTH_FILE)) {
    log('[oauth] Token file not found');
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf-8'));
    if (data.type !== 'oauth' || !data.access || !data.refresh) {
      log('[oauth] Invalid token file format');
      return null;
    }
    cachedTokens = data as OAuthData;
    return cachedTokens;
  } catch (err) {
    log(
      `[oauth] Failed to read token file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Check if the token file exists (quick check without full parsing).
 */
export function hasOAuthTokens(): boolean {
  return fs.existsSync(OAUTH_FILE);
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshToken(data: OAuthData): Promise<OAuthData> {
  log('[oauth] Refreshing access token...');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(
      `Token refresh failed: ${response.status} ${errorText}`,
    );
  }

  const result = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  const newData: OAuthData = {
    type: 'oauth',
    access: result.access_token,
    refresh: result.refresh_token || data.refresh, // Use new refresh token if provided
    expires: Date.now() + result.expires_in * 1000,
    accountId: data.accountId,
  };

  // Write back to file (syncs with host via mount)
  try {
    fs.writeFileSync(OAUTH_FILE, JSON.stringify(newData, null, 2));
    log('[oauth] Token refreshed and saved');
  } catch (err) {
    log(
      `[oauth] Token refreshed but failed to save: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cachedTokens = newData;
  return newData;
}

/**
 * Ensure the access token is valid. Refreshes if close to expiry.
 */
export async function ensureValidToken(): Promise<OAuthData> {
  let data = loadOAuthTokens();
  if (!data) {
    throw new Error('No OAuth tokens available. Run `npx tsx scripts/openai-login.ts` first.');
  }

  // Refresh if within safety margin of expiry
  if (Date.now() >= data.expires - SAFETY_MARGIN_MS) {
    data = await refreshToken(data);
  }

  return data;
}

/**
 * Get authorization headers for WHAM API requests.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const data = await ensureValidToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${data.access}`,
  };

  if (data.accountId) {
    headers['ChatGPT-Account-Id'] = data.accountId;
  }

  return headers;
}

/**
 * Wrapper that retries once on 401 after refreshing token.
 */
export async function withAutoRefresh<T>(
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const headers = await getAuthHeaders();

  try {
    return await fn(headers);
  } catch (err) {
    // Retry once on 401
    if (
      err instanceof Error &&
      err.message.includes('401')
    ) {
      log('[oauth] Got 401, forcing token refresh and retrying...');
      const data = loadOAuthTokens();
      if (data) {
        await refreshToken(data);
        const newHeaders = await getAuthHeaders();
        return fn(newHeaders);
      }
    }
    throw err;
  }
}
