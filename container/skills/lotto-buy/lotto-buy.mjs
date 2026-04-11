#!/usr/bin/env node
// 동행복권 로또 6/45 온라인 구매 스킬.
// See SKILL.md for usage, constraints, and contract.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_FILE =
  process.env.LOTTO_AUTH_FILE || '/workspace/auth/dhlottery-auth.json';
const PURCHASE_URL = 'https://ol.dhlottery.co.kr/olotto/game/game645.do';
const SESSION = 'lotto';
const PURCHASE_TIMEOUT_MS = 8000;

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

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(AUTH_FILE)) {
    out({
      status: 'error',
      code: 'AUTH_MISSING',
      message: `Auth file not found at ${AUTH_FILE}. Re-login on host and re-save with agent-browser state save.`,
    });
  }

  // Load session and navigate.
  ab(['state', 'load', AUTH_FILE]);
  ab(['open', PURCHASE_URL]);
  ab(['wait', '--load', 'networkidle']);

  // Session validity: purchase UI is only rendered for authenticated users.
  // When the session has expired the page shows an alert modal and no #payAmt.
  const sessionProbe = parseEvalJson(
    abEval(`(() => {
      const pa = document.getElementById('payAmt');
      if (pa) return { ok: true, payAmt: pa.textContent.trim() };
      // Detect the session-expired alert dialog
      const alert = document.getElementById('popupLayerAlert');
      const alertVisible = alert && getComputedStyle(alert).display !== 'none';
      const bodyText = (document.body.innerText || '').slice(0, 200);
      return { ok: false, alertVisible: !!alertVisible, bodyText };
    })()`).stdout,
  );
  if (!sessionProbe || !sessionProbe.ok) {
    out({
      status: 'error',
      code: 'SESSION_EXPIRED',
      message:
        '동행복권 세션 만료. 호스트에서 수동 재로그인 후 ~/.config/nanoclaw/dhlottery-auth.json 을 재저장해 주세요.',
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
