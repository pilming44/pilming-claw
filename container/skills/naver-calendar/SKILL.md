---
name: naver-calendar
description: 네이버 캘린더 일정을 조회, 생성, 수정, 삭제한다. 사용자가 일정, 스케줄, 캘린더, 약속, 미팅을 언급하면 사용.
---

# 네이버 캘린더

CalDAV 기반 네이버 캘린더 연동. 일정 조회/생성/수정/삭제 지원.

## 호출 방법

```bash
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs <command> [options]
```

## 명령어

### 일정 조회

```bash
# 오늘부터 7일간 일정
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs list

# 특정 기간 조회
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs list --from 2026-03-28 --to 2026-04-04
```

출력: JSON `{ count, events: [{ uid, title, start, end, location, description }] }`

### 일정 상세 조회

```bash
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs get <EVENT_UID>
```

### 일정 생성

```bash
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs create \
  --title "팀 미팅" \
  --start "2026-03-30 14:00" \
  --end "2026-03-30 15:00" \
  --description "주간 진행상황 공유" \
  --location "회의실 A"
```

- `--title`, `--start` 필수
- `--end` 생략 시 1시간 기본
- 날짜 형식: `2026-03-28`, `2026-03-28 14:00`, `2026-03-28T14:00:00`

### 일정 수정

```bash
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs update <EVENT_UID> \
  --title "변경된 제목" \
  --start "2026-03-30 15:00"
```

변경할 필드만 전달. 나머지는 기존 값 유지.

### 일정 삭제

```bash
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs delete <EVENT_UID>
```

## 사용 흐름

1. 사용자가 일정을 물으면 `list`로 조회 후 보기 좋게 정리하여 전달
2. 일정 생성 요청 시 제목, 시간, 장소 등을 확인한 후 `create` 실행
3. 수정/삭제 시 먼저 `list`로 대상 일정의 UID를 확인한 후 `update`/`delete` 실행
4. 결과를 `send_message` MCP tool로 사용자에게 전달

## 디버깅

`--debug` 플래그를 추가하면 raw HTTP 요청/응답이 stderr로 출력된다.

```bash
node /home/node/.claude/skills/naver-calendar/naver-cal.mjs list --debug
```
