---
name: kma-weather
description: 한국 기상청 공식 날씨 예보(현재 실황/단기/중기)와 한국환경공단 에어코리아 미세먼지/초미세먼지 조회. 사용자가 날씨, 기온, 비, 눈, 예보, 미세먼지, 황사, 공기질, 대기, 주말 날씨, 오늘 날씨를 언급하면 사용.
---

# 한국 기상청 날씨 + 미세먼지

공공데이터포털(data.go.kr) 공식 API 직접 조회. 웹 스크래핑 없이 JSON 응답을 바로 받아 빠르다. Node.js 22 내장 `fetch()` 만 사용, 외부 의존성 0.

## 호출 방법

```bash
node /home/node/.claude/skills/kma-weather/kma-weather.mjs <command> [options]
```

## 명령어

### 초단기 실황 (현재 날씨)

```bash
# 행정구역명으로
node /home/node/.claude/skills/kma-weather/kma-weather.mjs now "서울 강남구"

# 위경도로
node /home/node/.claude/skills/kma-weather/kma-weather.mjs now --lat 37.5665 --lon 126.9780
```

출력: JSON `{ base_date, base_time, location, temperature_c, humidity_pct, precipitation_mm, precipitation_type, wind_speed_ms, wind_direction, wind_direction_deg }`

- `precipitation_type`: `없음` / `비` / `비/눈` / `눈` / `소나기` / `빗방울` / `빗방울눈날림` / `눈날림`
- `wind_direction`: `N/NE/E/SE/S/SW/W/NW` 약어 (16방위 근사)

### 단기예보 (3일, 3시간 간격)

```bash
node /home/node/.claude/skills/kma-weather/kma-weather.mjs forecast "서울 강남구"
node /home/node/.claude/skills/kma-weather/kma-weather.mjs forecast "서울 강남구" --days 2
node /home/node/.claude/skills/kma-weather/kma-weather.mjs forecast --lat 37.5665 --lon 126.9780 --days 3
```

출력: JSON `{ base_date, base_time, location, days: [{ date, min_c, max_c, hours: [{ time, temperature_c, sky, precipitation_type, pop_pct, humidity_pct, wind_speed_ms, wind_direction }] }] }`

- `sky`: `맑음` / `구름많음` / `흐림`
- `pop_pct`: 강수확률 %
- `--days`: 1~3 (기본 3)

### 중기예보 (3~10일)

```bash
node /home/node/.claude/skills/kma-weather/kma-weather.mjs mid 서울
node /home/node/.claude/skills/kma-weather/kma-weather.mjs mid 부산
node /home/node/.claude/skills/kma-weather/kma-weather.mjs mid 제주
```

출력: JSON `{ tm_fc, land_region, temp_region, days: [{ day_offset, am_sky, am_pop_pct, pm_sky, pm_pop_pct, min_c, max_c }] }`

- `day_offset`: 3 ~ 10 (오늘 기준 N일 뒤)
- 3~7일차는 오전(am)/오후(pm) 구분, 8~10일차는 하루 단위 (am 필드에 전일 예보)

지원 지역: `서울 / 인천 / 수원 / 강릉 / 춘천 / 대전 / 세종 / 청주 / 광주 / 전주 / 목포 / 여수 / 대구 / 안동 / 포항 / 부산 / 울산 / 창원 / 제주 / 서귀포` 외 주요 도시.

### 미세먼지 / 대기질

```bash
node /home/node/.claude/skills/kma-weather/kma-weather.mjs air 서울
node /home/node/.claude/skills/kma-weather/kma-weather.mjs air 서울 --station 강남구
node /home/node/.claude/skills/kma-weather/kma-weather.mjs air 전국
```

출력: JSON `{ sido, count, stations: [{ station, data_time, pm10, pm10_grade, pm25, pm25_grade, khai, khai_grade, o3, no2, co, so2 }] }`

- `pm10_grade` / `pm25_grade` / `khai_grade`: `좋음` / `보통` / `나쁨` / `매우나쁨` / `점검중`
- `sido`: `서울`, `부산`, `대구`, `인천`, `광주`, `대전`, `울산`, `경기`, `강원`, `충북`, `충남`, `전북`, `전남`, `경북`, `경남`, `제주`, `세종`, `전국`
- `--station`: 결과를 이름 부분 일치로 필터링 (예: `강남`, `종로`)

## 사용 흐름

### "지금 서울 날씨 어때?"

1. `now "서울"` → 현재 기온/습도/강수/풍속 획득
2. 사람 친화적 문장으로 정리해 `send_message`

### "이번 주말 날씨?"

1. `mid 서울` → 3~10일 중 토/일에 해당하는 날 찾기
2. 오전/오후 하늘상태, 강수확률, 최저/최고 기온 정리

### "미세먼지 어때?"

1. `air 서울 --station {사용자 지역}` 또는 `air 서울`
2. 통합대기지수(khai_grade) 기준으로 외출 적합성 판단

### 위치 해석 우선순위

1. 사용자가 행정구역명을 말함 → 그대로 `<location>` 인자 사용
2. 미등록 지명 → 에러 시 `kakao-map address "..."` 로 좌표 변환 후 `--lat/--lon` 으로 재호출
3. 사용자가 "내 위치" / GPS 를 말함 → `kakao-map` 경유로 좌표 확보 후 호출

## 지원 행정구역

내장 매핑 테이블에 주요 시/도/구/군 약 200여 개 등록. 미등록 지명이면 `UNKNOWN_LOCATION` 에러 + `--lat/--lon` 사용 안내.

대표 예: `서울`, `서울 강남구`, `강남구`, `부산`, `부산 해운대구`, `해운대구`, `대구`, `인천`, `광주`, `대전`, `울산`, `세종`, `수원`, `고양`, `성남`, `용인`, `춘천`, `강릉`, `청주`, `천안`, `전주`, `목포`, `여수`, `포항`, `창원`, `제주`, `서귀포` 등.

## 제한 사항

- **일 트래픽**: data.go.kr 일반 인증키 10,000건/일 (서비스별). 같은 키로 날씨/미세먼지/중기예보 공유.
- **발표 시각 지연**: 초단기실황은 매시 40분 이후, 단기예보는 각 발표시각(02/05/08/11/14/17/20/23) + 10분 후 조회 가능.
- **중기예보**: 오늘 기준 3일 뒤부터 10일 뒤까지 (3일 이내 = 단기예보, 10일 초과 = 미지원).
- **격자 변환**: 기상청 단기예보는 5km Lambert 격자 기반이라 정밀 좌표는 가장 가까운 격자점에 반올림됨.
- **API 키 누락**: `DATA_GO_KR_API_KEY` 환경변수 미설정 시 즉시 에러. `.env` 에 추가 후 컨테이너 재빌드 필요.

## 에러 코드

```json
{
  "error": "ERROR_CODE",
  "message": "사람이 읽을 수 있는 설명"
}
```

| 코드 | 의미 | 조치 |
|---|---|---|
| `NO_API_KEY` | `DATA_GO_KR_API_KEY` 환경변수 없음 | `.env` 추가 + 컨테이너 재빌드 |
| `UNKNOWN_LOCATION` | 행정구역명 미등록 | `--lat/--lon` 또는 kakao-map 연동 |
| `UNKNOWN_REGION` | 중기예보/미세먼지 시도명 미지원 | 지원 지역 목록 확인 |
| `API_ERROR` | data.go.kr HTTP 오류 또는 잘못된 키 | `--debug` 로 원문 확인 |
| `NO_DATA` | API 응답에 예보 데이터 없음 | 발표 시각 대기 또는 재시도 |
| `USAGE` | 인자 부족/오류 | 도움말 참고 |

## 디버깅

`--debug` 플래그를 붙이면 raw HTTP 요청/응답이 stderr 로 출력된다.

```bash
node /home/node/.claude/skills/kma-weather/kma-weather.mjs now "서울" --debug
```

## 참고

- 기상청 단기예보 API: `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/`
- 기상청 중기예보 API: `https://apis.data.go.kr/1360000/MidFcstInfoService/`
- 에어코리아 대기질 API: `https://apis.data.go.kr/B552584/ArpltnInfoInqireSvc/`
- 격자 변환: KMA 공식 Lambert Conformal Conic 공식 (위도 30/60, 기준점 38°N 126°E)
