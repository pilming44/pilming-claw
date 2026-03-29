/**
 * OpenAI OAuth Login Script for NanoClaw.
 * Authenticates with ChatGPT subscription via OAuth 2.0 + PKCE.
 * Stores tokens at ~/.config/nanoclaw/openai-oauth.json.
 *
 * Usage: npx tsx scripts/openai-login.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

// --- OAuth Constants (from OpenAI Codex CLI) ---

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPES = 'openid profile email offline_access';
const CALLBACK_PORT = 1455;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'nanoclaw');
const TOKEN_FILE = path.join(CONFIG_DIR, 'openai-oauth.json');

// --- PKCE helpers ---

function generateCodeVerifier(): string {
  return crypto.randomBytes(96).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// --- JWT decode (no verification) ---

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

function extractAccountId(idToken: string, accessToken: string): string | null {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    try {
      const payload = decodeJwtPayload(token);

      // Level 1: top-level chatgpt_account_id
      if (typeof payload.chatgpt_account_id === 'string') {
        return payload.chatgpt_account_id;
      }

      // Level 2: nested in https://api.openai.com/auth
      const authClaim = payload['https://api.openai.com/auth'] as
        | Record<string, unknown>
        | undefined;
      if (authClaim && typeof authClaim.chatgpt_account_id === 'string') {
        return authClaim.chatgpt_account_id;
      }

      // Level 3: first organization ID
      const orgs = payload.organizations as Array<{ id: string }> | undefined;
      if (orgs && orgs.length > 0 && typeof orgs[0].id === 'string') {
        return orgs[0].id;
      }
    } catch {
      // try next token
    }
  }
  return null;
}

// --- Browser open ---

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`open ${JSON.stringify(url)}`);
    } else if (platform === 'linux') {
      execSync(`xdg-open ${JSON.stringify(url)} 2>/dev/null || sensible-browser ${JSON.stringify(url)}`);
    } else {
      execSync(`start ${JSON.stringify(url)}`);
    }
  } catch {
    console.log(`\nPlease open this URL manually:\n${url}\n`);
  }
}

// --- Token exchange ---

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
}> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

// --- Main ---

async function main(): Promise<void> {
  console.log('🔑 OpenAI ChatGPT 구독 로그인\n');

  // Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Build authorization URL
  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // OpenAI-specific parameters
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'opencode',
  });

  const authUrl = `${AUTH_URL}?${authParams}`;

  // Start local callback server
  const { code, receivedState } = await new Promise<{
    code: string;
    receivedState: string;
  }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '', `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const receivedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><h2>인증 실패</h2><p>이 창을 닫아도 됩니다.</p></body></html>',
        );
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || !receivedState) {
        res.writeHead(400);
        res.end('Missing code or state');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><h2>인증 성공!</h2><p>이 창을 닫아도 됩니다.</p></body></html>',
      );

      server.close();
      resolve({ code, receivedState });
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`Callback 서버 시작: http://localhost:${CALLBACK_PORT}`);
      console.log('브라우저에서 OpenAI 로그인 페이지를 엽니다...\n');
      openBrowser(authUrl);
    });

    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${CALLBACK_PORT} is already in use. Close any running login processes and try again.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Login timeout (5 minutes). Please try again.'));
    }, 5 * 60 * 1000);
  });

  // Validate state (CSRF protection)
  if (receivedState !== state) {
    throw new Error('State mismatch — possible CSRF attack. Please try again.');
  }

  console.log('토큰 교환 중...');

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code, codeVerifier);

  // Extract account ID from JWT
  const accountId = extractAccountId(tokens.id_token, tokens.access_token);

  if (!accountId) {
    console.warn(
      '⚠️  chatgpt_account_id를 JWT에서 추출하지 못했습니다. 일부 기능이 제한될 수 있습니다.',
    );
  }

  // Calculate expiry (milliseconds)
  const expiresMs = Date.now() + tokens.expires_in * 1000;

  // Save tokens
  const oauthData = {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: expiresMs,
    accountId: accountId || '',
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(oauthData, null, 2));
  fs.chmodSync(TOKEN_FILE, 0o600); // Read/write only for owner

  console.log(`\n✅ 로그인 성공!`);
  console.log(`   토큰 저장: ${TOKEN_FILE}`);
  console.log(`   Account ID: ${accountId || '(없음)'}`);
  console.log(
    `   토큰 만료: ${new Date(expiresMs).toLocaleString()}\n`,
  );
  console.log(
    'NanoClaw에서 @gpt 트리거 사용 시 ChatGPT 구독 할당량이 사용됩니다.',
  );
}

main().catch((err) => {
  console.error(`\n❌ 로그인 실패: ${err.message}`);
  process.exit(1);
});
