#!/usr/bin/env node
/**
 * Migration: Restructure ai-news scheduled tasks
 *
 * Old: 4 tasks (6h, 12h, daily, trending) with overlapping sources
 * New: 7 collection + 1 report (2x daily) + 1 trending = 9 tasks
 *
 * Collection runs at staggered 10-min intervals, report aggregates at :30
 * Morning: 07:00-08:00 collect → 08:30 report
 * Evening: 20:00-21:00 collect → 21:30 report
 */

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { randomBytes } from 'crypto';

const DB_PATH = new URL('../store/messages.db', import.meta.url).pathname;
const db = new Database(DB_PATH);

const CHAT_JID = 'slack:C0APA01KY1H';
const GROUP = 'slack_ai-news';
const TZ = 'Asia/Seoul';

function taskId() {
  return `task-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

function nextRun(cron) {
  const interval = CronExpressionParser.parse(cron, { tz: TZ });
  return interval.next().toISOString();
}

const now = new Date().toISOString();

// ── Shared script fragments ──

const SCRIPT_HEADER = `
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

const REPORTED_FILE = '/workspace/group/ai-news-reported.json';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' };

mkdirSync('/workspace/group/cache', { recursive: true });
mkdirSync('/workspace/group/staging', { recursive: true });

function loadCache(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
const reported = new Set(existsSync(REPORTED_FILE) ? JSON.parse(readFileSync(REPORTED_FILE, 'utf8')) : []);
`.trim();

function makeCollectScript(sourceId, sources) {
  return `node --input-type=module << 'SCRIPT_EOF'
${SCRIPT_HEADER}

const CACHE_FILE = '/workspace/group/cache/${sourceId}.json';
const STAGING_FILE = '/workspace/group/staging/${sourceId}.json';
const cache = loadCache(CACHE_FILE);
const newCache = { ...cache };
const changedPages = [];
const newArticles = [];

const SOURCES = ${JSON.stringify(sources, null, 2)};

const results = await Promise.allSettled(SOURCES.map(async (src) => {
  const r = await fetch(src.url, { signal: AbortSignal.timeout(10000), headers: HEADERS });
  if (!r.ok) throw new Error(\`HTTP \${r.status} for \${src.url}\`);
  const text = await r.text();
  const hash = createHash('md5').update(text.slice(0, 12000)).digest('hex');
  return { ...src, text, hash };
}));

for (const r of results) {
  if (r.status !== 'fulfilled') { console.error('[WARN]', r.reason?.message || 'fetch failed'); continue; }
  const { id, name, url, text, hash, type, base, prefix } = r.value;

  const isFirstRun = !cache[id];
  const hashChanged = cache[id] !== hash;
  newCache[id] = hash;

  if (isFirstRun) {
    // First run: extract existing URLs to prevent false positives
    if (type === 'blog' && base && prefix) {
      for (const m of text.matchAll(/href="([^"#?]+)"/g)) {
        let href = m[1];
        if (href.startsWith('/')) href = base + href;
        href = href.replace(/\\/$/, '');
        if (href.startsWith(base + prefix) && href.length > (base + prefix).length + 3) {
          reported.add(href);
        }
      }
    }
    continue;
  }
  if (!hashChanged) continue;

  if (type === 'changelog') {
    changedPages.push({ name, url });
  } else if (type === 'blog' && base && prefix) {
    for (const m of text.matchAll(/href="([^"#?]+)"/g)) {
      let href = m[1];
      if (href.startsWith('/')) href = base + href;
      href = href.replace(/\\/$/, '');
      if (href.startsWith(base + prefix) && href.length > (base + prefix).length + 3 && !reported.has(href)) {
        newArticles.push(href);
      }
    }
  }
}

writeFileSync(CACHE_FILE, JSON.stringify(newCache));

// On first run, persist newly discovered URLs to reported so next run won't flag them
if (Object.keys(cache).length === 0 && reported.size > 0) {
  writeFileSync(REPORTED_FILE, JSON.stringify([...reported].slice(-500)));
}

const uniqueArticles = [...new Set(newArticles)];
if (changedPages.length > 0 || uniqueArticles.length > 0) {
  writeFileSync(STAGING_FILE, JSON.stringify({
    source: '${sourceId}',
    timestamp: new Date().toISOString(),
    changedPages,
    newArticles: uniqueArticles,
  }));
}

console.log(JSON.stringify({ wakeAgent: false }));
SCRIPT_EOF`;
}

// ── Collection Scripts ──

const collections = [
  {
    id: 'openai',
    cron: '0 7,20 * * *',
    sources: [
      { id: 'openai-changelog', name: 'OpenAI API Changelog', url: 'https://platform.openai.com/docs/changelog', type: 'changelog' },
      { id: 'openai-news', name: 'OpenAI News', url: 'https://openai.com/news/', type: 'blog', base: 'https://openai.com', prefix: '/index/' },
      { id: 'chatgpt-rn', name: 'ChatGPT Release Notes', url: 'https://help.openai.com/en/articles/6825453-chatgpt-release-notes', type: 'changelog' },
    ],
    prompt: 'AI 뉴스 수집: OpenAI 소스 변경 감지 (수집 전용, 보고 없음)',
  },
  {
    id: 'anthropic',
    cron: '10 7,20 * * *',
    sources: [
      { id: 'anthropic-api', name: 'Anthropic API Release Notes', url: 'https://docs.anthropic.com/en/release-notes/api', type: 'changelog' },
      { id: 'anthropic-news', name: 'Anthropic Newsroom', url: 'https://www.anthropic.com/news', type: 'blog', base: 'https://www.anthropic.com', prefix: '/news/' },
      { id: 'anthropic-engineering', name: 'Anthropic Engineering', url: 'https://www.anthropic.com/engineering', type: 'blog', base: 'https://www.anthropic.com', prefix: '/engineering/' },
    ],
    prompt: 'AI 뉴스 수집: Anthropic 소스 변경 감지 (수집 전용, 보고 없음)',
  },
  {
    id: 'github',
    cron: '20 7,20 * * *',
    sources: [
      { id: 'github-changelog', name: 'GitHub Changelog', url: 'https://github.blog/changelog/', type: 'blog', base: 'https://github.blog', prefix: '/changelog/' },
    ],
    prompt: 'AI 뉴스 수집: GitHub Changelog 변경 감지 (수집 전용, 보고 없음)',
  },
  {
    id: 'google',
    cron: '30 7,20 * * *',
    sources: [
      { id: 'gemini-api', name: 'Gemini API Changelog', url: 'https://ai.google.dev/gemini-api/docs/changelog', type: 'changelog' },
      { id: 'google-deepmind', name: 'Google DeepMind Blog', url: 'https://deepmind.google/discover/blog/', type: 'blog', base: 'https://deepmind.google', prefix: '/discover/blog/' },
      { id: 'google-blog', name: 'Google Blog (DeepMind)', url: 'https://blog.google/technology/google-deepmind/', type: 'blog', base: 'https://blog.google', prefix: '/technology/google-deepmind/' },
    ],
    prompt: 'AI 뉴스 수집: Google/DeepMind 소스 변경 감지 (수집 전용, 보고 없음)',
  },
  {
    id: 'grok',
    cron: '40 7,20 * * *',
    sources: [
      { id: 'xai-changelog', name: 'xAI Docs Changelog', url: 'https://docs.x.ai/changelog', type: 'changelog' },
      { id: 'xai-news', name: 'xAI News', url: 'https://x.ai/news', type: 'blog', base: 'https://x.ai', prefix: '/news/' },
    ],
    prompt: 'AI 뉴스 수집: xAI/Grok 소스 변경 감지 (수집 전용, 보고 없음)',
  },
  {
    id: 'meta',
    cron: '50 7,20 * * *',
    sources: [
      { id: 'meta-ai-blog', name: 'Meta AI Blog', url: 'https://ai.meta.com/blog/', type: 'blog', base: 'https://ai.meta.com', prefix: '/blog/' },
      { id: 'meta-llama', name: 'Meta Llama', url: 'https://www.llama.com/blog/', type: 'blog', base: 'https://www.llama.com', prefix: '/blog/' },
    ],
    prompt: 'AI 뉴스 수집: Meta 소스 변경 감지 (수집 전용, 보고 없음)',
  },
];

// Mistral + HN: special script with HN Algolia API
const mistralHnScript = `node --input-type=module << 'SCRIPT_EOF'
${SCRIPT_HEADER}

const CACHE_FILE = '/workspace/group/cache/mistral-hn.json';
const STAGING_FILE = '/workspace/group/staging/mistral-hn.json';
const cache = loadCache(CACHE_FILE);
const newCache = { ...cache };
const changedPages = [];
const newArticles = [];

// ── Mistral sources ──
const SOURCES = [
  { id: 'mistral-news', name: 'Mistral News', url: 'https://mistral.ai/news/', type: 'blog', base: 'https://mistral.ai', prefix: '/news/' },
  { id: 'mistral-docs', name: 'Mistral Docs Changelog', url: 'https://docs.mistral.ai/getting-started/changelog/', type: 'changelog' },
];

const results = await Promise.allSettled(SOURCES.map(async (src) => {
  const r = await fetch(src.url, { signal: AbortSignal.timeout(10000), headers: HEADERS });
  if (!r.ok) throw new Error(\`HTTP \${r.status} for \${src.url}\`);
  const text = await r.text();
  const hash = createHash('md5').update(text.slice(0, 12000)).digest('hex');
  return { ...src, text, hash };
}));

for (const r of results) {
  if (r.status !== 'fulfilled') { console.error('[WARN]', r.reason?.message || 'fetch failed'); continue; }
  const { id, name, url, text, hash, type, base, prefix } = r.value;
  const isFirstRun = !cache[id];
  const hashChanged = cache[id] !== hash;
  newCache[id] = hash;
  if (isFirstRun) {
    if (type === 'blog' && base && prefix) {
      for (const m of text.matchAll(/href="([^"#?]+)"/g)) {
        let href = m[1];
        if (href.startsWith('/')) href = base + href;
        href = href.replace(/\\/$/, '');
        if (href.startsWith(base + prefix) && href.length > (base + prefix).length + 3) {
          reported.add(href);
        }
      }
    }
    continue;
  }
  if (!hashChanged) continue;
  if (type === 'changelog') {
    changedPages.push({ name, url });
  } else if (type === 'blog' && base && prefix) {
    for (const m of text.matchAll(/href="([^"#?]+)"/g)) {
      let href = m[1];
      if (href.startsWith('/')) href = base + href;
      href = href.replace(/\\/$/, '');
      if (href.startsWith(base + prefix) && href.length > (base + prefix).length + 3 && !reported.has(href)) {
        newArticles.push(href);
      }
    }
  }
}

// ── Hacker News (Algolia API) ──
const HN_RE = /\\b(AI|LLM|GPT|Claude|Gemini|Anthropic|OpenAI|machine.?learning|neural|transformer|AGI|DeepSeek|Llama|Mistral|Grok|Copilot|diffusion|foundation.?model|language.?model|chatbot|inference|fine.?tun)\\b/i;
const reportedHnIds = new Set((cache.reportedHnIds || []).map(String));
const lastHnCheck = cache.lastHnCheck || 0;
const hnSince = lastHnCheck === 0 ? Math.floor(Date.now() / 1000) - 6 * 3600 : lastHnCheck;
let hnStories = [];

try {
  const hnUrl = \`https://hn.algolia.com/api/v1/search?tags=story&numericFilters=points%3E50,created_at_i%3E\${hnSince}&hitsPerPage=30\`;
  const hnRes = await fetch(hnUrl, { signal: AbortSignal.timeout(8000), headers: HEADERS });
  const hnData = await hnRes.json();
  hnStories = (hnData.hits || [])
    .filter(h => HN_RE.test(h.title))
    .filter(h => !reportedHnIds.has(String(h.objectID)))
    .slice(0, 5)
    .map(h => ({
      id: String(h.objectID),
      title: h.title,
      url: h.url || \`https://news.ycombinator.com/item?id=\${h.objectID}\`,
      hnUrl: \`https://news.ycombinator.com/item?id=\${h.objectID}\`,
      points: h.points,
      time: h.created_at,
    }));
} catch {}

newCache.reportedHnIds = [...reportedHnIds, ...hnStories.map(s => s.id)].slice(-300);
newCache.lastHnCheck = Math.floor(Date.now() / 1000);
writeFileSync(CACHE_FILE, JSON.stringify(newCache));

if (Object.keys(cache).length === 0 && reported.size > 0) {
  writeFileSync(REPORTED_FILE, JSON.stringify([...reported].slice(-500)));
}

const uniqueArticles = [...new Set(newArticles)];
if (changedPages.length > 0 || uniqueArticles.length > 0 || hnStories.length > 0) {
  writeFileSync(STAGING_FILE, JSON.stringify({
    source: 'mistral-hn',
    timestamp: new Date().toISOString(),
    changedPages,
    newArticles: uniqueArticles,
    hnStories,
  }));
}

console.log(JSON.stringify({ wakeAgent: false }));
SCRIPT_EOF`;

// ── Report Script ──

const reportScript = `node --input-type=module << 'SCRIPT_EOF'
import { readFileSync, readdirSync, unlinkSync, existsSync } from 'fs';

const STAGING_DIR = '/workspace/group/staging';
if (!existsSync(STAGING_DIR)) {
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

const files = readdirSync(STAGING_DIR).filter(f => f.endsWith('.json'));
if (files.length === 0) {
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

const allData = [];
for (const f of files) {
  try {
    const data = JSON.parse(readFileSync(STAGING_DIR + '/' + f, 'utf8'));
    allData.push(data);
  } catch {}
}

// Clean staging files
for (const f of files) {
  try { unlinkSync(STAGING_DIR + '/' + f); } catch {}
}

const totalChanges = allData.reduce((sum, d) =>
  sum + (d.changedPages?.length || 0) + (d.newArticles?.length || 0) + (d.hnStories?.length || 0), 0);

if (totalChanges === 0) {
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

console.log(JSON.stringify({ wakeAgent: true, data: { sources: allData } }));
SCRIPT_EOF`;

const reportPrompt = `AI 뉴스 통합 리포트를 작성하고 채널에 전송하세요.

## 스크립트 데이터 구조
data.sources 배열에 각 소스별 수집 결과가 있습니다:
- changedPages: 변경 감지된 changelog 페이지 (URL 방문하여 최근 항목 추출 필요)
- newArticles: 새로 발견된 블로그/뉴스 기사 URL 목록
- hnStories: Hacker News AI 관련 인기 스토리

## 작업 순서

### 1단계: 데이터 없음 처리
data.sources가 비어있으면 → 보고 없이 종료

### 2단계: 중복 방지
1. /workspace/group/ai-news-reported.json 읽기 (없으면 빈 배열)
2. 이미 reported 목록에 있는 URL은 보고하지 않음

### 3단계: 콘텐츠 수집
- changedPages의 각 URL 방문 → 최근 항목 추출 (최근 12시간 이내)
- newArticles의 각 URL 방문 → 제목, 날짜, 내용 요약 수집
- hnStories는 스크립트가 이미 정보를 제공 (추가 방문 불필요)
- WebSearch로 추가 확인: "Perplexity changelog", "Cohere docs changelog" 최신 항목

### 4단계: 보고
신규 항목이 있으면 send_message로 아래 포맷 전송:

\`\`\`
📢 *AI 뉴스 업데이트* (통합 리포트)

• 핵심제목(30자이내) | 매체명 | 날짜(MM/DD HH:MM, 없으면 "최신") | 내용요약(50자이내) \`URL\`
• 핵심제목(30자이내) | 매체명 | 날짜 | 내용요약 \`URL\`

🟠 *Hacker News AI picks:*
• 제목 | 🔥 N pts | \`URL\`

_모니터링: OpenAI · Anthropic · GitHub · Google · xAI · Meta · Mistral · HN · Perplexity · Cohere_
\`\`\`

신규 항목 없으면:
\`\`\`
🔕 *AI 뉴스 업데이트 없음* (통합 리포트)
변경 감지되었으나 신규 보고 항목 없음.
\`\`\`

### 5단계: 상태 저장
보고한 URL들을 /workspace/group/ai-news-reported.json에 추가 저장 (최대 500개, 초과 시 오래된 것부터 제거)

## 포맷 규칙
- Slack mrkdwn 사용
- URL은 반드시 백틱(\`)으로 감쌀 것 (미리보기 방지)
- 각 항목은 한 줄로 작성
- 동일 내용의 영문/한국어 URL은 중복 제거 후 한 번만 보고
- HN 섹션은 HN 스토리가 있을 때만 표시`;

// ── GitHub Trending (updated with better dedup) ──

const trendingScript = `node --input-type=module << 'SCRIPT_EOF'
import { readFileSync, writeFileSync, existsSync } from 'fs';

const REPORTED_FILE = '/workspace/group/github-trending-reported.json';
const state = existsSync(REPORTED_FILE) ? JSON.parse(readFileSync(REPORTED_FILE, 'utf8')) : { repos: [], history: [] };

// Ensure history array exists (migration from old format)
if (!state.history) state.history = [...(state.repos || [])];

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
let repos = [];

try {
  const r = await fetch('https://github.com/trending?since=daily', { signal: AbortSignal.timeout(10000), headers: HEADERS });
  const html = await r.text();
  const rows = html.match(/<article class="Box-row">[\\s\\S]*?<\\/article>/g) || [];
  repos = rows.slice(0, 3).map((row, i) => {
    const nameMatch = row.match(/href="\\/([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : '';
    const descMatch = row.match(/<p class="[^"]*">(.*?)<\\/p>/s);
    const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const starsMatch = row.match(/(\\d[\\d,]*) stars today/);
    const stars = starsMatch ? starsMatch[1] : '?';
    const langMatch = row.match(/itemprop="programmingLanguage">([^<]+)/);
    const lang = langMatch ? langMatch[1].trim() : '';
    return { rank: i + 1, name, url: 'https://github.com/' + name, desc, stars, lang };
  });
} catch {}

if (repos.length === 0) {
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

const historySet = new Set(state.history || []);
const newRepos = repos.filter(r => !historySet.has(r.name));

// Update history: add current repos, keep max 100
const updatedHistory = [...new Set([...repos.map(r => r.name), ...(state.history || [])])].slice(0, 100);
writeFileSync(REPORTED_FILE, JSON.stringify({ repos: repos.map(r => r.name), history: updatedHistory }));

if (newRepos.length === 0) {
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

console.log(JSON.stringify({ wakeAgent: true, data: { repos, newRepos, prevRepoNames: state.repos } }));
SCRIPT_EOF`;

const trendingPrompt = `GitHub Trending 일간 TOP 3 레포지토리를 채널에 보고하세요.

## 1단계: 변동 없음 처리 (최우선)
스크립트 data.newRepos가 비어있으면 → 보고 없이 종료

## 2단계: 신규 진입 레포만 보고
data.newRepos에 있는 레포만 보고합니다. 이전에 보고된 레포는 제외됩니다 (최대 100개 기억).

## 3단계: 보고
send_message로 아래 포맷 전송:

\`\`\`
⭐ *GitHub Trending - 신규 진입* (YYYY년 MM월 DD일)

*N위. 레포이름* — 언어 | ⭐ 오늘 N stars
\`https://github.com/owner/repo\`
레포 설명 + 오늘 주목받는 이유 (1-2줄)
\`\`\`

## 포맷 규칙
- Slack mrkdwn 사용
- URL은 반드시 백틱(\`)으로 감쌀 것
- 각 레포 사이에 빈 줄 추가`;

// ── Execute Migration ──

console.log('=== AI News Task Migration ===\n');

// Step 1: Deactivate old tasks
const oldTaskIds = [
  'task-1774703947728-lovsr3',  // 6h
  'task-1774703959282-e8vler',  // 12h
  'task-1774703972240-cwjx66',  // daily
  'task-1774705099278-lk3p0m',  // trending
];

const deactivate = db.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?');
for (const id of oldTaskIds) {
  deactivate.run('paused', id);
  console.log(`⏸  Paused: ${id}`);
}

// Step 2: Create collection tasks
const insert = db.prepare(`
  INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, vendor, next_run, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const col of collections) {
  const id = taskId();
  const script = makeCollectScript(col.id, col.sources);
  const nr = nextRun(col.cron);
  insert.run(id, GROUP, CHAT_JID, col.prompt, script, 'cron', col.cron, 'isolated', 'claude', nr, 'active', now);
  console.log(`✅ Collection: ${col.id.padEnd(12)} cron=${col.cron.padEnd(16)} next=${nr.slice(0, 19)} id=${id}`);
  // Small delay for unique task IDs
  await new Promise(r => setTimeout(r, 5));
}

// Mistral + HN (special script)
{
  const id = taskId();
  const cron = '0 8,21 * * *';
  const nr = nextRun(cron);
  insert.run(id, GROUP, CHAT_JID, 'AI 뉴스 수집: Mistral + Hacker News 변경 감지 (수집 전용, 보고 없음)', mistralHnScript, 'cron', cron, 'isolated', 'claude', nr, 'active', now);
  console.log(`✅ Collection: mistral-hn   cron=${cron.padEnd(16)} next=${nr.slice(0, 19)} id=${id}`);
}

// Step 3: Create report task
{
  const id = taskId();
  const cron = '30 8,21 * * *';
  const nr = nextRun(cron);
  insert.run(id, GROUP, CHAT_JID, reportPrompt, reportScript, 'cron', cron, 'isolated', 'claude', nr, 'active', now);
  console.log(`✅ Report:     unified      cron=${cron.padEnd(16)} next=${nr.slice(0, 19)} id=${id}`);
}

// Step 4: Create GitHub Trending task
{
  const id = taskId();
  const cron = '0 9 * * *';
  const nr = nextRun(cron);
  insert.run(id, GROUP, CHAT_JID, trendingPrompt, trendingScript, 'cron', cron, 'isolated', 'claude', nr, 'active', now);
  console.log(`✅ Trending:   github       cron=${cron.padEnd(16)} next=${nr.slice(0, 19)} id=${id}`);
}

console.log('\n=== Migration Complete ===');
console.log(`Old tasks paused: ${oldTaskIds.length}`);
console.log(`New tasks created: ${collections.length + 3}`);

db.close();
