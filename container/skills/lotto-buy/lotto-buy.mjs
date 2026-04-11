#!/usr/bin/env node
// 동행복권 로또 6/45 온라인 구매 스킬.
// See SKILL.md for usage, constraints, and contract.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_FILE =
  process.env.LOTTO_AUTH_FILE || '/workspace/auth/dhlottery-auth.json';
const CREDS_FILE =
  process.env.LOTTO_CREDS_FILE || '/workspace/auth/dhlottery-creds.json';
const PURCHASE_URL = 'https://ol.dhlottery.co.kr/olotto/game/game645.do';
const MAIN_URL = 'https://dhlottery.co.kr/common/main.do';
const LOGIN_URL = 'https://www.dhlottery.co.kr/login';
const SESSION = 'lotto';
const PURCHASE_TIMEOUT_MS = 8000;
const LOGIN_TIMEOUT_MS = 8000;

// 동행복권 봇 탐지 우회:
// 1) headed Chromium (Xvfb 는 컨테이너 엔트리포인트가 제공)
// 2) `--disable-blink-features=AutomationControlled` — 이게 빠지면 CDP 어태치
//    직후 navigator.webdriver=true 로 찍혀 서버가 즉시 차단한다 (probe 로 확인됨).
// 실제 env 는 container/Dockerfile 의 ENV AGENT_BROWSER_HEADED / ARGS 에서
// 박힌다 — 여기서 process.env 로 덮으면 agent-browser daemon 이 이미 떠 있는
// 경우 너무 늦어서 적용 안 됨. 아래 코드는 "누가 호스트에서 이 파일을 직접
// 돌리더라도 같은 효과가 나도록" 하는 fallback.
if (!process.env.AGENT_BROWSER_HEADED) process.env.AGENT_BROWSER_HEADED = 'true';
if (!process.env.AGENT_BROWSER_ARGS) {
  process.env.AGENT_BROWSER_ARGS =
    '--no-sandbox,--disable-blink-features=AutomationControlled';
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
  process.exit(obj.status === 'error' ? 1 : 0);
}

function ab(cmdArgs) {
  const args = ['--session', SESSION, ...cmdArgs];
  const r = spawnSync('agent-browser', args, { encoding: 'utf8' });
  return {
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function abEval(js) {
  const tmp = path.join(
    os.tmpdir(),
    `lotto-eval-${process.pid}-${Date.now()}.js`,
  );
  fs.writeFileSync(tmp, js);
  try {
    // Pipe file contents as the single argument to avoid shell escaping hell.
    const r = spawnSync('agent-browser', ['--session', SESSION, 'eval', js], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      code: r.status,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
    };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function parseEvalJson(stdout) {
  // agent-browser eval prints the returned value. Objects print as JSON-ish.
  // Strip the trailing reset line if any.
  const cleaned = stdout.replace(/^Shell cwd.*$/gm, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract the first JSON-looking block.
    const m = cleaned.match(/[{\[][\s\S]*[}\]]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    // Strip surrounding quotes for a plain string return.
    return cleaned.replace(/^"(.*)"$/, '$1');
  }
}

function parseArgs(argv) {
  const args = { games: 5, mode: 'auto', confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games') args.games = parseInt(argv[++i], 10);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: lotto-buy.mjs [--games 1..5] [--mode auto] [--confirm]',
      );
      process.exit(0);
    }
  }
  if (!(args.games >= 1 && args.games <= 5)) {
    out({
      status: 'error',
      code: 'BAD_ARGS',
      message: 'games must be an integer 1..5',
    });
  }
  if (args.mode !== 'auto') {
    out({
      status: 'error',
      code: 'BAD_ARGS',
      message: `mode "${args.mode}" not yet supported (only "auto")`,
    });
  }
  return args;
}

function die(code, message, extra = {}) {
  // Best-effort: try to reset cart on the way out so the next run starts clean.
  try {
    abEval(`(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type=button]'));
      const reset = btns.find(b => /초기화/.test((b.textContent || b.value || '')) && b.offsetParent !== null);
      if (reset) reset.click();
      return reset ? 'reset' : 'no-reset';
    })()`);
  } catch {}
  out({ status: 'error', code, message, ...extra });
}

// Try to log back in using stored credentials. Returns 'ok' on success, or
// an object { code, detail } on failure. Codes: 'CAPTCHA' | 'BAD_CREDENTIALS' |
// 'NO_CREDS_FILE' | 'CREDS_READ_ERROR' | 'CREDS_PARSE_ERROR' |
// 'CREDS_MISSING_KEYS' | 'UNKNOWN'.
function tryRelogin() {
  if (!fs.existsSync(CREDS_FILE)) return { code: 'NO_CREDS_FILE' };
  let raw;
  try {
    raw = fs.readFileSync(CREDS_FILE, 'utf8');
  } catch (e) {
    // Includes the macOS Docker single-file bind mount inode-stale ENOENT case
    // (file appears in directory listing but reads fail). Container restart
    // re-binds the current host inode.
    return { code: 'CREDS_READ_ERROR', detail: String(e && e.message) };
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    return { code: 'CREDS_PARSE_ERROR', detail: String(e && e.message) };
  }
  if (!creds.userId || !creds.password) return { code: 'CREDS_MISSING_KEYS' };

  // Establish referer via main page, then navigate to login form.
  ab(['open', MAIN_URL]);
  ab(['wait', '--load', 'networkidle']);
  ab(['open', LOGIN_URL]);
  ab(['wait', '--load', 'networkidle']);

  // Bail out if dhlottery shows CAPTCHA on this attempt.
  const preCheck = parseEvalJson(
    abEval(`(() => ({
      hasIdInput: !!document.getElementById('inpUserId'),
      hasPwInput: !!document.getElementById('inpUserPswdEncn'),
      captchaImg: document.querySelectorAll('img[src*="captcha" i]').length,
      recaptcha: document.querySelectorAll('[class*="recaptcha" i], [id*="recaptcha" i]').length,
      url: location.href,
    }))()`).stdout,
  );
  if (!preCheck || !preCheck.hasIdInput || !preCheck.hasPwInput) {
    return { code: 'UNKNOWN', detail: preCheck };
  }
  if (preCheck.captchaImg > 0 || preCheck.recaptcha > 0) {
    return { code: 'CAPTCHA', detail: preCheck };
  }

  // Use real CDP fill+click so the form's submit handlers fire normally.
  ab(['fill', '#inpUserId', creds.userId]);
  ab(['fill', '#inpUserPswdEncn', creds.password]);
  ab(['click', '#btnLogin']);
  ab(['wait', '--load', 'networkidle']);

  // Logged-in heuristic: the login form is gone or url left /login.
  const after = parseEvalJson(
    abEval(`(() => {
      const stillOnLogin = /\\/login(?:$|\\?)/.test(location.pathname + location.search);
      const idInput = document.getElementById('inpUserId');
      const alert = document.getElementById('popupLayerAlert');
      const alertVisible = alert && getComputedStyle(alert).display !== 'none';
      const alertText = alertVisible ? (alert.innerText || '').trim().slice(0, 200) : null;
      return { stillOnLogin, hasIdInput: !!idInput, alertVisible, alertText, url: location.href };
    })()`).stdout,
  );
  if (after && after.alertVisible) {
    return { code: 'BAD_CREDENTIALS', detail: after.alertText };
  }
  if (!after || after.stillOnLogin || after.hasIdInput) {
    return { code: 'BAD_CREDENTIALS', detail: after };
  }

  // Persist the freshly minted cookies so future runs skip the relogin.
  ab(['state', 'save', AUTH_FILE]);
  return { code: 'ok' };
}

function probeSession() {
  ab(['open', PURCHASE_URL]);
  ab(['wait', '--load', 'networkidle']);
  return parseEvalJson(
    abEval(`(() => {
      const pa = document.getElementById('payAmt');
      if (pa) return { ok: true, payAmt: pa.textContent.trim() };
      const alert = document.getElementById('popupLayerAlert');
      const alertVisible = alert && getComputedStyle(alert).display !== 'none';
      const bodyText = (document.body.innerText || '').slice(0, 200);
      return { ok: false, alertVisible: !!alertVisible, bodyText };
    })()`).stdout,
  );
}

function main() {
  const args = parseArgs(process.argv);

  // Load cached cookies if present. The cache file is optional now —
  // tryRelogin() can bootstrap from creds.json on first run or when stale.
  if (fs.existsSync(AUTH_FILE)) {
    ab(['state', 'load', AUTH_FILE]);
  }
  let sessionProbe = probeSession();

  // If the saved cookie is stale, try to silently re-login using stored creds.
  if (!sessionProbe || !sessionProbe.ok) {
    const r = tryRelogin();
    if (r.code === 'ok') {
      sessionProbe = probeSession();
    } else if (r.code === 'CAPTCHA') {
      out({
        status: 'error',
        code: 'SESSION_EXPIRED_CAPTCHA',
        message:
          '동행복권이 로그인 시 CAPTCHA 를 요구합니다. 호스트에서 수동 로그인 후 ~/.config/nanoclaw/dhlottery-auth.json 재저장 필요.',
        detail: r.detail,
      });
    } else if (r.code === 'BAD_CREDENTIALS') {
      out({
        status: 'error',
        code: 'BAD_CREDENTIALS',
        message:
          '~/.config/nanoclaw/dhlottery-creds.json 의 ID/PW 가 거부됐습니다. 자격증명 확인 필요.',
        detail: r.detail,
      });
    } else if (r.code === 'NO_CREDS_FILE') {
      out({
        status: 'error',
        code: 'NO_CREDS_FILE',
        message:
          '~/.config/nanoclaw/dhlottery-creds.json 이 없어 자동 로그인 불가. {"userId":"...","password":"..."} 형식으로 생성 후 chmod 600 필요.',
      });
    } else if (r.code === 'CREDS_READ_ERROR') {
      out({
        status: 'error',
        code: 'CREDS_READ_ERROR',
        message:
          '~/.config/nanoclaw/dhlottery-creds.json 읽기 실패. macOS Docker 의 single-file bind mount 가 stale 일 수 있음 — 컨테이너 재기동 필요.',
        detail: r.detail,
      });
    } else if (r.code === 'CREDS_PARSE_ERROR') {
      out({
        status: 'error',
        code: 'CREDS_PARSE_ERROR',
        message:
          '~/.config/nanoclaw/dhlottery-creds.json 의 JSON 파싱에 실패했습니다. (smart quote / trailing comma 등 확인)',
        detail: r.detail,
      });
    } else if (r.code === 'CREDS_MISSING_KEYS') {
      out({
        status: 'error',
        code: 'CREDS_MISSING_KEYS',
        message:
          '~/.config/nanoclaw/dhlottery-creds.json 에 userId 또는 password 키가 없습니다.',
      });
    } else {
      out({
        status: 'error',
        code: 'RELOGIN_FAILED',
        message: `자동 재로그인 실패 (${r.code}). 호스트에서 수동 로그인 필요.`,
        detail: r.detail || sessionProbe,
      });
    }
  }
  if (!sessionProbe || !sessionProbe.ok) {
    out({
      status: 'error',
      code: 'SESSION_EXPIRED',
      message:
        '재로그인 후에도 구매 페이지 진입 실패. 호스트에서 수동 로그인 필요.',
      detail: sessionProbe,
    });
  }

  // Also reset cart in case a previous run left crumbs.
  abEval(`(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type=button]'));
    const reset = btns.find(b => /초기화/.test((b.textContent || b.value || '')) && b.offsetParent !== null);
    if (reset) reset.click();
    return reset ? 'reset' : 'none';
  })()`);
  ab(['wait', '300']);

  // 1. Turn on 자동선택 (label click triggers the change event properly).
  abEval(`(() => {
    const cb = document.getElementById('checkAutoSelect');
    if (!cb) return 'no checkbox';
    if (!cb.checked) {
      const label = document.querySelector('label[for="checkAutoSelect"]');
      if (label) label.click(); else cb.click();
    }
    return cb.checked;
  })()`);

  // 2. Set 적용수량 = games and dispatch change so the framework picks it up.
  abEval(`(() => {
    const sel = document.getElementById('amoundApply');
    if (!sel) return 'no select';
    sel.value = '${args.games}';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);

  // 3. Click 선택번호 확인 — this adds #games auto games into slots A..N.
  const addResult = parseEvalJson(
    abEval(`(() => {
      const btn = document.getElementById('btnSelectNum');
      if (!btn) return { err: 'no btnSelectNum' };
      btn.click();
      return { clicked: true };
    })()`).stdout,
  );
  if (!addResult || !addResult.clicked) {
    die('CART_ADD_FAILED', 'Could not click #btnSelectNum', { addResult });
  }
  ab(['wait', '600']);

  // 4. Verify payAmt matches expected. If a validation dialog opened, dismiss it.
  const afterAdd = parseEvalJson(
    abEval(`(() => {
      const pa = document.getElementById('payAmt').textContent.trim();
      const slots = ['A','B','C','D','E'].map(a => {
        const el = document.getElementById('selectGbn' + a);
        return el ? el.textContent.trim() : '?';
      });
      const alert = document.getElementById('popupLayerAlert');
      const alertVisible = alert && getComputedStyle(alert).display !== 'none';
      const alertText = alertVisible ? (alert.innerText || '').trim().slice(0, 300) : null;
      return { payAmt: pa, slots, alertVisible, alertText };
    })()`).stdout,
  );
  const expectedAmt = args.games * 1000;
  const actualAmt = parseInt(
    ((afterAdd && afterAdd.payAmt) || '0').replace(/[^\d]/g, ''),
    10,
  );
  if (afterAdd && afterAdd.alertVisible) {
    die('CART_ADD_ALERT', 'Alert modal raised after cart add', { afterAdd });
  }
  if (actualAmt !== expectedAmt) {
    die(
      'PAY_MISMATCH',
      `Expected ${expectedAmt}원 after adding ${args.games} games, got ${actualAmt}원`,
      { afterAdd },
    );
  }

  // 5. Click 구매하기.
  abEval(`(() => {
    const btn = document.getElementById('btnBuy');
    if (!btn) return 'no btnBuy';
    btn.click();
    return 'clicked';
  })()`);

  // Wait for the confirm layer to appear.
  const confirmShown = parseEvalJson(
    abEval(`(() => {
      const el = document.getElementById('popupLayerConfirm');
      if (!el) return { shown: false, err: 'no popupLayerConfirm' };
      const start = Date.now();
      return { shown: getComputedStyle(el).display !== 'none', text: (el.innerText || '').trim().slice(0, 120) };
    })()`).stdout,
  );
  // Some sites delay the confirm render — poll a few times.
  let confirmReady = confirmShown && confirmShown.shown;
  for (let i = 0; i < 10 && !confirmReady; i++) {
    ab(['wait', '200']);
    const probe = parseEvalJson(
      abEval(`(() => {
        const el = document.getElementById('popupLayerConfirm');
        return { shown: el && getComputedStyle(el).display !== 'none' };
      })()`).stdout,
    );
    confirmReady = probe && probe.shown;
  }
  if (!confirmReady) {
    die('MODAL_NOT_FOUND', 'popupLayerConfirm did not appear after #btnBuy');
  }

  // 6. Branch: dry-run cancels, confirm proceeds.
  if (!args.confirm) {
    const cancelResult = parseEvalJson(
      abEval(`(() => {
        const root = document.getElementById('popupLayerConfirm');
        if (!root) return { err: 'no root' };
        // cancel button: has class 'cancel', or text '취소'
        const btns = Array.from(root.querySelectorAll('button, input[type=button], a'));
        const cancel = btns.find(b => /cancel/i.test(b.className || '') || /취소/.test(b.textContent || b.value || ''));
        if (!cancel) return { err: 'no cancel button', candidates: btns.map(b => (b.textContent || b.value || '').trim()) };
        cancel.click();
        return { clicked: true };
      })()`).stdout,
    );
    if (!cancelResult || !cancelResult.clicked) {
      die('MODAL_CANCEL_FAILED', 'Could not click cancel on popupLayerConfirm', {
        cancelResult,
      });
    }
    ab(['wait', '400']);
    // Reset cart to clean state.
    abEval(`(() => {
      const reset = Array.from(document.querySelectorAll('button, input[type=button]'))
        .find(b => /초기화/.test((b.textContent || b.value || '')) && b.offsetParent !== null);
      if (reset) reset.click();
      return reset ? 'reset' : 'none';
    })()`);
    out({
      status: 'ok',
      mode: 'dry-run',
      games: args.games,
      payAmt: expectedAmt,
      message: `카트에 ${args.games}게임 추가 후 구매 취소. 실결제는 일어나지 않았습니다.`,
    });
  }

  // 7. Confirm the real purchase.
  const confirmClick = parseEvalJson(
    abEval(`(() => {
      const root = document.getElementById('popupLayerConfirm');
      if (!root) return { err: 'no root' };
      const btns = Array.from(root.querySelectorAll('button, input[type=button], a'));
      // Confirm button: class contains 'confirm' but NOT 'cancel', or text '확인'
      const ok = btns.find(b => {
        const cls = (b.className || '').toLowerCase();
        const txt = (b.textContent || b.value || '').trim();
        if (/cancel/.test(cls)) return false;
        return /confirm/.test(cls) || txt === '확인';
      });
      if (!ok) return { err: 'no confirm button', candidates: btns.map(b => (b.textContent || b.value || '').trim()) };
      ok.click();
      return { clicked: true };
    })()`).stdout,
  );
  if (!confirmClick || !confirmClick.clicked) {
    die('MODAL_CONFIRM_FAILED', 'Could not click confirm on popupLayerConfirm', {
      confirmClick,
    });
  }

  // 8. Wait for either success receipt or a failure alert.
  const started = Date.now();
  let result = null;
  while (Date.now() - started < PURCHASE_TIMEOUT_MS) {
    ab(['wait', '400']);
    const probe = parseEvalJson(
      abEval(`(() => {
        const receipt = document.getElementById('report');
        const receiptVisible = receipt && getComputedStyle(receipt).display !== 'none';
        const alert = document.getElementById('popupLayerAlert');
        const alertVisible = alert && getComputedStyle(alert).display !== 'none';
        const alertText = alertVisible ? (alert.innerText || '').trim() : null;
        const row = document.getElementById('reportRow');
        const hasGames = row && row.querySelectorAll('li').length > 0;
        return { receiptVisible, alertVisible, alertText, hasGames };
      })()`).stdout,
    );
    if (probe && probe.alertVisible) {
      die('PURCHASE_REJECTED', `서버가 구매를 거부했습니다: ${probe.alertText}`, {
        alertText: probe.alertText,
      });
    }
    if (probe && probe.hasGames) {
      result = probe;
      break;
    }
  }
  if (!result) {
    die(
      'RECEIPT_TIMEOUT',
      `영수증이 ${PURCHASE_TIMEOUT_MS}ms 내에 나타나지 않았습니다. 네트워크 또는 서버 응답 지연.`,
    );
  }

  // 9. Parse the receipt.
  const receiptJson = parseEvalJson(
    abEval(`(() => {
      const out = { games: [] };
      const row = document.getElementById('reportRow');
      if (row) {
        for (const li of row.querySelectorAll('li')) {
          const spans = Array.from(li.querySelectorAll('span'))
            .map(s => (s.textContent || '').trim())
            .filter(Boolean);
          out.games.push(spans);
        }
      }
      const pick = id => {
        const el = document.getElementById(id);
        return el ? (el.textContent || '').trim() : null;
      };
      out.buyRound = pick('buyRound');
      out.drawDate = pick('drawDate');
      out.issueDay = pick('issueDay');
      out.payLimitDate = pick('payLimitDate');
      out.nBuyAmount = pick('nBuyAmount');
      return out;
    })()`).stdout,
  );

  // 10. Save the state file back in case the server refreshed cookies.
  try {
    ab(['state', 'save', AUTH_FILE]);
  } catch {}

  out({
    status: 'ok',
    mode: 'confirmed',
    games: args.games,
    payAmt: expectedAmt,
    receipt: receiptJson,
    message: `실결제 완료: ${args.games}게임 / ${expectedAmt}원`,
  });
}

main();
