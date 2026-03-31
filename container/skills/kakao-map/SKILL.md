---
name: kakao-map
description: 길찾기(자동차/도보/대중교통/자전거)와 장소·주소 검색. 사용자가 길찾기, 경로, 지도, 장소 검색, 주소, 어떻게 가, 몇 분 걸려를 언급하면 사용.
---

# 카카오맵 길찾기

Kakao REST API 기반 장소 검색 + 자동차 경로 조회. 도보/대중교통/자전거는 카카오맵 URL + agent-browser로 정보 수집.

## 호출 방법

```bash
node /home/node/.claude/skills/kakao-map/kakao-map.mjs <command> [options]
```

## 명령어

### 장소 검색

```bash
# 키워드로 장소 검색
node /home/node/.claude/skills/kakao-map/kakao-map.mjs search "강남역"

# 특정 위치 근처 검색 (거리순 정렬)
node /home/node/.claude/skills/kakao-map/kakao-map.mjs search "스타벅스" --x 127.027 --y 37.498
```

출력: JSON `{ count, places: [{ name, address, road_address, x, y, phone, category }] }`

### 주소 → 좌표 변환

```bash
node /home/node/.claude/skills/kakao-map/kakao-map.mjs address "서울 강남구 역삼동 858"
```

출력: JSON `{ address, x, y, address_type, road_address }`

### 좌표 → 주소 변환

```bash
node /home/node/.claude/skills/kakao-map/kakao-map.mjs reverse-geocode --x 127.027 --y 37.498
```

출력: JSON `{ address, road_address, x, y }`

### 자동차 경로 조회

```bash
node /home/node/.claude/skills/kakao-map/kakao-map.mjs directions \
  --origin 127.027,37.498 \
  --dest 127.108,37.359 \
  --priority RECOMMEND
```

- `--origin`, `--dest`: 경도,위도 순서 (lng,lat)
- `--priority`: `RECOMMEND` (기본), `TIME` (최단시간), `DISTANCE` (최단거리)

출력: JSON `{ summary: { distance_km, duration_min, taxi_fare, toll_fare }, steps: [...], step_count }`

### 카카오맵 URL 생성

```bash
node /home/node/.claude/skills/kakao-map/kakao-map.mjs route-url \
  --origin-name "강남역" --origin-lat 37.498 --origin-lng 127.027 \
  --dest-name "판교역" --dest-lat 37.394 --dest-lng 127.111 \
  --mode PUBLICTRANSIT
```

- `--mode`: `FOOT` (도보), `PUBLICTRANSIT` (대중교통), `BICYCLE` (자전거), `CAR` (자동차)

출력: JSON `{ mode, app_url, web_url }`

## 사용 흐름

### 자동차 경로 (REST API 직접 조회)

1. `search "출발지"` + `search "도착지"` 로 좌표(x, y) 획득
2. `directions --origin x,y --dest x,y` 로 상세 경로 데이터 조회
3. 거리/시간/요금/턴바이턴 안내를 보기 좋게 정리하여 `send_message`로 전달

### 도보/대중교통/자전거 경로 (agent-browser 스크래핑)

1. `search "출발지"` + `search "도착지"` 로 좌표(x, y)와 이름 획득
2. `route-url --origin-name 이름 --origin-lat y값 --origin-lng x값 --dest-name 이름 --dest-lat y값 --dest-lng x값 --mode MODE` 로 web_url 획득
3. `agent-browser open "{web_url}"` 로 카카오맵 웹 열기
4. `agent-browser wait --load networkidle` 로 페이지 로드 대기
5. `agent-browser snapshot -i` 로 페이지 구조 확인
6. 필요시 이동수단 버튼 클릭 (`agent-browser click @eN`)
7. `agent-browser snapshot` 또는 `agent-browser get text @eN` 로 경로 정보 추출
8. 추출된 정보 (소요시간, 거리, 환승 정보, 요금 등)를 정리하여 `send_message`로 전달
9. 필요시 `agent-browser screenshot /workspace/group/route.png` → `send_file`로 지도 스크린샷 첨부

### 이동수단 판별 기준

- 미지정 또는 "자동차/차/드라이브/운전" → 자동차 (directions 사용)
- "걸어서/도보/걸어가" → FOOT
- "버스/지하철/대중교통/전철" → PUBLICTRANSIT
- "자전거/따릉이" → BICYCLE

## 좌표 순서 주의

- **Kakao API** (search, address, directions): `x = 경도(lng)`, `y = 위도(lat)`
- **카카오맵 URL** (route-url): `lat,lng` 순서 (반대)
- search 결과의 x,y 값을 directions에는 `--origin x,y` 그대로 사용
- route-url에는 `--origin-lat y값 --origin-lng x값` 으로 바꿔서 전달

## 제한 사항

- 자동차 경로만 REST API로 상세 조회 가능 (거리, 시간, 요금, 턴바이턴)
- 도보/대중교통/자전거는 카카오맵 웹을 agent-browser로 접근하여 정보 수집
- 자전거 경로는 카카오맵 웹에서 지원 범위가 제한적일 수 있음
- agent-browser 사용 시 페이지 로드에 수 초 소요
- 카카오맵 웹 UI 구조가 변경될 수 있으므로 항상 snapshot으로 먼저 확인 후 상호작용

## 디버깅

`--debug` 플래그를 추가하면 raw HTTP 요청/응답이 stderr로 출력된다.

```bash
node /home/node/.claude/skills/kakao-map/kakao-map.mjs search "강남역" --debug
```
