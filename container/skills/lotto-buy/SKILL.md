---
name: lotto-buy
description: 동행복권 로또 6/45 온라인 구매. 사용자가 "로또 구매", "로또 사줘", "로또 자동 N게임" 등을 명시적으로 요청했을 때만 호출한다. 스케줄/크론으로 자동 호출 금지 (약관 제12조 ①.9 위반). 호출 시 사용자가 직접 의도한 1회 트리거여야 한다.
---

# 동행복권 로또 6/45 구매 스킬

## 중요 제약
- **수동 트리거 전용**. cron, task-scheduler, interval, 반복 호출 금지. 동행복권 이용약관 제12조 ①.9 ("특정 기능을 반복적 또는 규칙적으로 호출하는 행위") 위반.
- **기본값은 dry-run**. `--confirm` 플래그가 명시적으로 주어진 경우에만 실제 결제.
- 실행 전 사용자에게 구매 내용(자동/수동, 게임수, 금액)을 확인받고, 결제 직전에 한번 더 확인하는 것을 원칙으로 한다.

## 호출 방법

```bash
node /home/node/.claude/skills/lotto-buy/lotto-buy.mjs [options]
```

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--games <N>` | `5` | 구매 게임수 (1~5) |
| `--mode <auto\|manual\|mixed>` | `auto` | 번호 선택 방식. 현재 `auto`만 구현 |
| `--confirm` | false | 실제 결제 진행. 없으면 dry-run (장바구니 담고 결제 취소) |

## 인증 파일

| 파일 | 역할 | 사용자 관리? |
|---|---|---|
| `~/.config/nanoclaw/dhlottery-creds.json` | ID/PW (`{"userId":"...","password":"..."}`, chmod 600) | ⭕ 한 번 생성 |
| `~/.config/nanoclaw/dhlottery-auth.json` | 로그인 cookie 캐시 | ❌ 스킬이 자동 관리 |

creds 만 만들어두면 첫 호출 시 자동 로그인 → 캐시 생성 → 이후 ~2~3시간은 캐시 hit. 세션 만료되면 자동 재로그인.

## 동작 순서

1. (있으면) `dhlottery-auth.json` 캐시 로드 → 구매 페이지 진입
2. 세션 유효 체크 (`#payAmt` 엘리먼트 존재 여부)
3. 무효면 `tryRelogin()`: main.do → /login → ID/PW 입력 → `#btnLogin` 클릭 → 성공 시 `state save` 로 캐시 갱신
4. 자동선택 체크박스 켜기 (`#checkAutoSelect` 라벨 클릭)
5. 적용수량 select(`#amoundApply`) 에 게임수 세팅 + change 이벤트
6. 장바구니 확인 버튼(`#btnSelectNum`) 클릭 → A~{games}슬롯에 자동 번호 추가
7. `#payAmt` 가 `games × 1000`과 일치하는지 검증
8. 구매하기 버튼(`#btnBuy`) 클릭 → 구매 확인 모달 (`#popupLayerConfirm`)
9. **dry-run**: 모달의 취소 버튼 클릭 → 장바구니 초기화 → 미리보기 출력
   **confirm**: 모달의 확인 버튼 클릭 → 실결제 → `#reportRow` 파싱 → 번호 JSON 출력

## 출력 형식

성공 (dry-run):
```json
{
  "status": "ok",
  "mode": "dry-run",
  "games": 5,
  "payAmt": 5000,
  "message": "카트에 5게임 추가 후 취소. 실결제 안 함."
}
```

성공 (confirm):
```json
{
  "status": "ok",
  "mode": "confirmed",
  "games": 5,
  "payAmt": 5000,
  "receipt": {
    "buyRound": "제 1219회",
    "drawDate": "2026/04/11",
    "issueDay": "2026/04/11 (토) 14:34:55",
    "payLimitDate": "2027/04/12",
    "nBuyAmount": "5,000",
    "games": [
      ["A", "자    동", "06", "11", "17", "23", "37", "44"],
      ["B", "자    동", "03", "05", "10", "12", "21", "44"],
      ...
    ]
  }
}
```

실패:
```json
{
  "status": "error",
  "code": "SESSION_EXPIRED" | "NO_CREDS_FILE" | "CREDS_PARSE_ERROR" | "CREDS_READ_ERROR" | "CREDS_MISSING_KEYS" | "BAD_CREDENTIALS" | "SESSION_EXPIRED_CAPTCHA" | "RELOGIN_FAILED" | "PAY_MISMATCH" | "MODAL_NOT_FOUND" | "PURCHASE_REJECTED" | "UNEXPECTED",
  "message": "사람이 읽을 수 있는 설명"
}
```

## 에러 처리

- **NO_CREDS_FILE**: `~/.config/nanoclaw/dhlottery-creds.json` 없음. 자동 로그인 불가. 사용자에게 creds 파일 생성 안내.
- **CREDS_PARSE_ERROR**: creds 파일 JSON 파싱 실패 (smart quote, trailing comma 등). 사용자에게 파일 점검 안내.
- **CREDS_READ_ERROR**: creds 파일 read 실패 (macOS Docker single-file bind mount stale 가능). 컨테이너 재기동 안내.
- **CREDS_MISSING_KEYS**: creds 파일에 `userId`/`password` 키 누락.
- **BAD_CREDENTIALS**: ID/PW 가 동행복권 서버에서 거부됨. 자격증명 확인 안내.
- **SESSION_EXPIRED_CAPTCHA**: 로그인 시 CAPTCHA 트립. 호스트에서 수동 로그인 + state save 필요.
- **SESSION_EXPIRED**: 캐시 만료 + creds 도 없음 (위 NO_CREDS_FILE 경로로 흡수됨, 실질 발생 안 함).
- **PAY_MISMATCH**: 자동 선택/확인 이후 `#payAmt`가 기대값과 다름. UI 상태 이상.
- **MODAL_NOT_FOUND**: `#popupLayerConfirm` 또는 영수증(`#popReceipt`) 모달이 제때 뜨지 않음.
- **PURCHASE_REJECTED**: execBuy.do가 "비정상적인 방법으로 접속" 알림 반환. Playwright 봇 탐지 우회가 풀린 상태 — 설계 재검토.

## 사용 예시

```bash
# 기본 (dry-run, 자동 5게임 preview)
node /home/node/.claude/skills/lotto-buy/lotto-buy.mjs

# 자동 1게임 실결제
node /home/node/.claude/skills/lotto-buy/lotto-buy.mjs --games 1 --confirm

# 자동 5게임 실결제
node /home/node/.claude/skills/lotto-buy/lotto-buy.mjs --games 5 --confirm
```

## 구매 후 사용자 보고 가이드

실구매 성공 시, 응답의 `receipt.games` 배열을 사용자에게 채널 메시지로 전달한다. 각 슬롯은 `[슬롯명, 모드, n1, n2, n3, n4, n5, n6]` 형식이므로 다음처럼 포맷:

```
제1219회 (2026/04/11 토) 로또 5게임 구매 완료 (5,000원)
A 자동: 06, 11, 17, 23, 37, 44
B 자동: 03, 05, 10, 12, 21, 44
C 자동: ...
```

## 재로그인 플로우

스킬 자체는 자동 재로그인을 시도하지 않는다 (자격증명 평문 저장 금지, CAPTCHA/OTP 대응 불가, 약관 제11조 ② "접근수단 위탁" 관련 리스크). 대신 세션 만료 감지 시:

1. `SESSION_EXPIRED` 에러 반환
2. 사용자에게 "호스트 머신에서 헤드풀 agent-browser 창을 띄우고 로그인한 뒤 `agent-browser state save ~/.config/nanoclaw/dhlottery-auth.json`을 실행해 주세요" 안내
3. 사용자가 완료하면 스킬 재실행

## 약관 관련 체크리스트

스킬 호출 전 반드시 확인:
- [ ] 사용자가 이번 메시지에서 명시적으로 로또 구매를 요청했는가? (과거 요청 기반 X)
- [ ] 스케줄러/cron/task-scheduler에서 호출된 것이 아닌가?
- [ ] `--confirm`을 쓰는 경우 사용자가 결제 의사를 명확히 밝혔는가?
- [ ] 예치금이 충분한가? (부족시 구매 실패)
- [ ] 판매 시간인가? (매주 토요일 20:00 ~ 일요일 06:00 사이 판매 중단)
