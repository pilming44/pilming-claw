#!/usr/bin/env node

/**
 * kma-weather — Korea Meteorological Administration (기상청) +
 *               AirKorea (에어코리아 / 한국환경공단) CLI.
 *
 * Zero external deps. Uses Node.js 22 built-in fetch().
 *
 * Environment variables:
 *   DATA_GO_KR_API_KEY — 공공데이터포털(data.go.kr) 일반 인증키 (디코딩된 키 권장)
 *
 * Usage:
 *   kma-weather now <location|--lat LAT --lon LON>
 *   kma-weather forecast <location|--lat LAT --lon LON> [--days 1|2|3]
 *   kma-weather mid <region>
 *   kma-weather air <sido> [--station NAME]
 *   kma-weather --help
 *
 * Output: JSON on stdout for success, {error, message} JSON on stderr for errors.
 */

import process from 'node:process';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.DATA_GO_KR_API_KEY;
const VILAGE_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const MID_BASE = 'https://apis.data.go.kr/1360000/MidFcstInfoService';
const AIR_BASE = 'https://apis.data.go.kr/B552584/ArpltnInfoInqireSvc';
const DEBUG = process.argv.includes('--debug');

// ─── Error helpers ───────────────────────────────────────────────────────────

function die(code, message, extra) {
  const payload = { error: code, message };
  if (extra) Object.assign(payload, extra);
  console.error(JSON.stringify(payload));
  process.exit(1);
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ─── Location → lat/lon table ────────────────────────────────────────────────
// 주요 시/도/구/군 대표 좌표. 미등록 지명은 --lat/--lon 사용 안내.
// 정밀한 격자 반영이 필요한 경우 사용자가 kakao-map 으로 좌표 변환 후 재호출.

const LOCATIONS = {
  // 서울
  서울: [37.5665, 126.9780],
  '서울 종로구': [37.5730, 126.9794], 종로구: [37.5730, 126.9794],
  '서울 중구': [37.5636, 126.9974],
  '서울 용산구': [37.5322, 126.9903], 용산구: [37.5322, 126.9903],
  '서울 성동구': [37.5634, 127.0369], 성동구: [37.5634, 127.0369],
  '서울 광진구': [37.5384, 127.0822], 광진구: [37.5384, 127.0822],
  '서울 동대문구': [37.5744, 127.0396], 동대문구: [37.5744, 127.0396],
  '서울 중랑구': [37.6065, 127.0925], 중랑구: [37.6065, 127.0925],
  '서울 성북구': [37.5894, 127.0167], 성북구: [37.5894, 127.0167],
  '서울 강북구': [37.6396, 127.0257], 강북구: [37.6396, 127.0257],
  '서울 도봉구': [37.6687, 127.0471], 도봉구: [37.6687, 127.0471],
  '서울 노원구': [37.6542, 127.0568], 노원구: [37.6542, 127.0568],
  '서울 은평구': [37.6028, 126.9293], 은평구: [37.6028, 126.9293],
  '서울 서대문구': [37.5791, 126.9368], 서대문구: [37.5791, 126.9368],
  '서울 마포구': [37.5663, 126.9019], 마포구: [37.5663, 126.9019],
  '서울 양천구': [37.5169, 126.8665], 양천구: [37.5169, 126.8665],
  '서울 강서구': [37.5509, 126.8495],
  '서울 구로구': [37.4954, 126.8874], 구로구: [37.4954, 126.8874],
  '서울 금천구': [37.4569, 126.8955], 금천구: [37.4569, 126.8955],
  '서울 영등포구': [37.5264, 126.8963], 영등포구: [37.5264, 126.8963],
  '서울 동작구': [37.5124, 126.9393], 동작구: [37.5124, 126.9393],
  '서울 관악구': [37.4784, 126.9516], 관악구: [37.4784, 126.9516],
  '서울 서초구': [37.4837, 127.0325], 서초구: [37.4837, 127.0325],
  '서울 강남구': [37.4979, 127.0276], 강남구: [37.4979, 127.0276],
  '서울 송파구': [37.5145, 127.1060], 송파구: [37.5145, 127.1060],
  '서울 강동구': [37.5301, 127.1238],

  // 부산
  부산: [35.1796, 129.0756],
  '부산 중구': [35.1061, 129.0323],
  '부산 서구': [35.0976, 129.0242],
  '부산 동구': [35.1295, 129.0454],
  '부산 영도구': [35.0913, 129.0679], 영도구: [35.0913, 129.0679],
  '부산 부산진구': [35.1630, 129.0531], 부산진구: [35.1630, 129.0531],
  '부산 동래구': [35.1975, 129.0837], 동래구: [35.1975, 129.0837],
  '부산 남구': [35.1364, 129.0840],
  '부산 북구': [35.1970, 129.0085],
  '부산 해운대구': [35.1629, 129.1636], 해운대구: [35.1629, 129.1636],
  '부산 사하구': [35.1049, 128.9749], 사하구: [35.1049, 128.9749],
  '부산 금정구': [35.2428, 129.0925], 금정구: [35.2428, 129.0925],
  '부산 강서구': [35.2123, 128.9805],
  '부산 연제구': [35.1762, 129.0795], 연제구: [35.1762, 129.0795],
  '부산 수영구': [35.1456, 129.1137], 수영구: [35.1456, 129.1137],
  '부산 사상구': [35.1527, 128.9910], 사상구: [35.1527, 128.9910],
  '부산 기장군': [35.2445, 129.2222], 기장군: [35.2445, 129.2222],

  // 대구
  대구: [35.8714, 128.6014],
  '대구 중구': [35.8693, 128.6062],
  '대구 동구': [35.8864, 128.6350],
  '대구 서구': [35.8720, 128.5592],
  '대구 남구': [35.8459, 128.5977],
  '대구 북구': [35.8853, 128.5825],
  '대구 수성구': [35.8583, 128.6309], 수성구: [35.8583, 128.6309],
  '대구 달서구': [35.8299, 128.5326], 달서구: [35.8299, 128.5326],
  '대구 달성군': [35.7747, 128.4316], 달성군: [35.7747, 128.4316],

  // 인천
  인천: [37.4563, 126.7052],
  '인천 중구': [37.4738, 126.6216],
  '인천 동구': [37.4738, 126.6432],
  '인천 미추홀구': [37.4638, 126.6500], 미추홀구: [37.4638, 126.6500],
  '인천 연수구': [37.4100, 126.6785], 연수구: [37.4100, 126.6785],
  '인천 남동구': [37.4476, 126.7316], 남동구: [37.4476, 126.7316],
  '인천 부평구': [37.5073, 126.7217], 부평구: [37.5073, 126.7217],
  '인천 계양구': [37.5375, 126.7378], 계양구: [37.5375, 126.7378],
  '인천 서구': [37.5455, 126.6761],
  '인천 강화군': [37.7469, 126.4878], 강화군: [37.7469, 126.4878],

  // 광주
  광주: [35.1595, 126.8526],
  '광주 동구': [35.1465, 126.9234],
  '광주 서구': [35.1523, 126.8901],
  '광주 남구': [35.1330, 126.9024],
  '광주 북구': [35.1742, 126.9121],
  '광주 광산구': [35.1396, 126.7937], 광산구: [35.1396, 126.7937],

  // 대전
  대전: [36.3504, 127.3845],
  '대전 동구': [36.3113, 127.4548],
  '대전 중구': [36.3256, 127.4214],
  '대전 서구': [36.3550, 127.3838],
  '대전 유성구': [36.3625, 127.3562], 유성구: [36.3625, 127.3562],
  '대전 대덕구': [36.3466, 127.4150], 대덕구: [36.3466, 127.4150],

  // 울산
  울산: [35.5384, 129.3114],
  '울산 중구': [35.5685, 129.3325],
  '울산 남구': [35.5439, 129.3304],
  '울산 동구': [35.5047, 129.4168],
  '울산 북구': [35.5824, 129.3610],
  '울산 울주군': [35.5224, 129.2424], 울주군: [35.5224, 129.2424],

  // 세종
  세종: [36.4801, 127.2890],

  // 경기
  수원: [37.2636, 127.0286],
  성남: [37.4201, 127.1262],
  고양: [37.6584, 126.8320],
  용인: [37.2411, 127.1776],
  부천: [37.5035, 126.7660],
  안산: [37.3219, 126.8308],
  안양: [37.3943, 126.9568],
  남양주: [37.6359, 127.2165],
  화성: [37.1995, 126.8310],
  평택: [36.9921, 127.1127],
  의정부: [37.7380, 127.0337],
  파주: [37.7603, 126.7799],
  시흥: [37.3799, 126.8031],
  김포: [37.6153, 126.7159],
  광명: [37.4781, 126.8644],
  군포: [37.3616, 126.9352],
  하남: [37.5391, 127.2148],
  오산: [37.1499, 127.0775],
  이천: [37.2722, 127.4351],
  안성: [37.0080, 127.2797],
  의왕: [37.3447, 126.9685],
  양주: [37.7853, 127.0456],
  구리: [37.5944, 127.1296],
  포천: [37.8949, 127.2003],
  동두천: [37.9038, 127.0607],
  과천: [37.4292, 126.9879],

  // 강원
  춘천: [37.8813, 127.7298],
  강릉: [37.7519, 128.8761],
  원주: [37.3422, 127.9202],
  속초: [38.2070, 128.5918],
  삼척: [37.4500, 129.1650],
  동해: [37.5247, 129.1142],
  태백: [37.1641, 128.9857],
  평창: [37.3706, 128.3903],
  홍천: [37.6971, 127.8884],

  // 충북
  청주: [36.6424, 127.4890],
  충주: [36.9910, 127.9259],
  제천: [37.1327, 128.1910],

  // 충남
  천안: [36.8151, 127.1139],
  아산: [36.7898, 127.0018],
  서산: [36.7848, 126.4503],
  당진: [36.8937, 126.6464],
  공주: [36.4467, 127.1189],
  보령: [36.3334, 126.6127],
  논산: [36.1872, 127.0984],

  // 전북
  전주: [35.8242, 127.1480],
  군산: [35.9676, 126.7366],
  익산: [35.9483, 126.9575],
  정읍: [35.5696, 126.8556],
  남원: [35.4163, 127.3906],

  // 전남
  목포: [34.8118, 126.3922],
  여수: [34.7604, 127.6622],
  순천: [34.9506, 127.4871],
  광양: [34.9406, 127.6959],
  나주: [35.0160, 126.7108],
  해남: [34.5734, 126.5989],

  // 경북
  포항: [36.0320, 129.3650],
  경주: [35.8562, 129.2247],
  구미: [36.1196, 128.3443],
  안동: [36.5684, 128.7294],
  영주: [36.8058, 128.6240],
  상주: [36.4107, 128.1590],
  문경: [36.5866, 128.1867],
  김천: [36.1399, 128.1137],
  영천: [35.9731, 128.9386],
  경산: [35.8251, 128.7411],

  // 경남
  창원: [35.2284, 128.6811],
  김해: [35.2285, 128.8894],
  진주: [35.1799, 128.1076],
  양산: [35.3349, 129.0373],
  거제: [34.8806, 128.6212],
  통영: [34.8544, 128.4331],
  사천: [35.0036, 128.0635],
  밀양: [35.5037, 128.7466],

  // 제주
  제주: [33.4996, 126.5312],
  제주시: [33.4996, 126.5312],
  서귀포: [33.2541, 126.5601],
  서귀포시: [33.2541, 126.5601],
};

// ─── Mid-forecast region codes (기상청 공식) ───────────────────────────────────

const MID_LAND_REGIONS = {
  서울: '11B00000', 인천: '11B00000', 수원: '11B00000', 파주: '11B00000',
  춘천: '11D10000', 원주: '11D10000',
  강릉: '11D20000',
  대전: '11C20000', 세종: '11C20000', 천안: '11C20000', 서산: '11C20000',
  청주: '11C10000',
  광주: '11F20000', 목포: '11F20000', 여수: '11F20000',
  전주: '11F10000', 군산: '11F10000',
  대구: '11H10000', 안동: '11H10000', 포항: '11H10000',
  부산: '11H20000', 울산: '11H20000', 창원: '11H20000',
  제주: '11G00000', 서귀포: '11G00000',
};

const MID_TEMP_REGIONS = {
  서울: '11B10101',
  인천: '11B20201',
  수원: '11B20601',
  파주: '11B20305',
  춘천: '11D10301',
  원주: '11D10401',
  강릉: '11D20501',
  대전: '11C20401',
  세종: '11C20404',
  천안: '11C20102',
  서산: '11C20101',
  청주: '11C10301',
  광주: '11F20501',
  목포: '11F20401',
  여수: '11F20801',
  전주: '11F10201',
  군산: '11F10401',
  대구: '11H10701',
  안동: '11H10501',
  포항: '11H10201',
  부산: '11H20201',
  울산: '11H20101',
  창원: '11H20301',
  제주: '11G00201',
  서귀포: '11G00401',
};

// ─── Air quality sido list ───────────────────────────────────────────────────

const AIR_SIDO = [
  '전국', '서울', '부산', '대구', '인천', '광주', '대전', '울산', '경기',
  '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '세종',
];

// ─── Category decoders ──────────────────────────────────────────────────────

const SKY_MAP = { 1: '맑음', 3: '구름많음', 4: '흐림' };

// 초단기실황 PTY: 0없음 1비 2비/눈 3눈 5빗방울 6빗방울눈날림 7눈날림
const PTY_MAP_ULTRA = {
  0: '없음', 1: '비', 2: '비/눈', 3: '눈',
  5: '빗방울', 6: '빗방울눈날림', 7: '눈날림',
};
// 단기예보 PTY: 0없음 1비 2비/눈 3눈 4소나기
const PTY_MAP_SHORT = {
  0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기',
};

const GRADE_MAP = { 1: '좋음', 2: '보통', 3: '나쁨', 4: '매우나쁨' };

// ─── Lambert Conformal Conic grid conversion (KMA 공식) ──────────────────────
// 기준점: 북위 38°, 동경 126°, 투영위도 30°/60°, 격자 5km, XO=43, YO=136.

function latLonToGrid(lat, lon) {
  const RE = 6371.00877;
  const GRID = 5.0;
  const SLAT1 = 30.0;
  const SLAT2 = 60.0;
  const OLON = 126.0;
  const OLAT = 38.0;
  const XO = 43;
  const YO = 136;
  const DEGRAD = Math.PI / 180.0;

  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx, ny };
}

// ─── Wind direction 16-point compass ────────────────────────────────────────

function vecToDirection(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return null;
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.floor((Number(deg) + 11.25) / 22.5) % 16;
  return dirs[(idx + 16) % 16];
}

// ─── Date/time helpers (컨테이너의 TZ=Asia/Seoul 을 신뢰) ────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function ultraNcstBaseTime(now = new Date()) {
  // 매시 정각 발표. 매시 40분 이후부터 조회 가능.
  const d = new Date(now);
  if (d.getMinutes() < 40) d.setHours(d.getHours() - 1);
  return { base_date: ymd(d), base_time: `${pad2(d.getHours())}00` };
}

function vilageFcstBaseTime(now = new Date()) {
  // 발표: 02, 05, 08, 11, 14, 17, 20, 23. 각 +10분 이후 조회 가능.
  const publishHours = [2, 5, 8, 11, 14, 17, 20, 23];
  const d = new Date(now);
  for (let i = publishHours.length - 1; i >= 0; i--) {
    const h = publishHours[i];
    const threshold = new Date(d);
    threshold.setHours(h, 10, 0, 0);
    if (d.getTime() >= threshold.getTime()) {
      const picked = new Date(d);
      picked.setHours(h, 0, 0, 0);
      return { base_date: ymd(picked), base_time: `${pad2(h)}00` };
    }
  }
  // 02:10 이전: 전일 23시 발표 사용
  const y = new Date(d);
  y.setDate(y.getDate() - 1);
  y.setHours(23, 0, 0, 0);
  return { base_date: ymd(y), base_time: '2300' };
}

function midForecastTmFc(now = new Date()) {
  // 발표: 06, 18. yyyyMMddHH00 형식.
  const d = new Date(now);
  const h = d.getHours();
  if (h < 6) {
    d.setDate(d.getDate() - 1);
    return `${ymd(d)}1800`;
  }
  if (h < 18) return `${ymd(d)}0600`;
  return `${ymd(d)}1800`;
}

// ─── Value parsers ──────────────────────────────────────────────────────────

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function parsePcp(raw) {
  // RN1/PCP 는 숫자 또는 '강수없음'/'1mm 미만'/'30.0~50.0mm'/'50.0mm 이상' 등의 문자열.
  if (raw === undefined || raw === null || raw === '' || raw === '강수없음') return 0;
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  return raw;
}

// ─── HTTP helper ────────────────────────────────────────────────────────────
// data.go.kr serviceKey 는 발급 시 `+` `/` `=` 를 포함할 수 있어 수동 인코딩.

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function apiGet(baseUrl, path, params, { retries = MAX_RETRIES, throwOnFail = false } = {}) {
  const parts = [`serviceKey=${encodeURIComponent(API_KEY)}`];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  const url = `${baseUrl}${path}?${parts.join('&')}`;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (DEBUG) console.error(`[DEBUG] GET ${url} (attempt ${attempt}/${retries})`);

    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await res.text();

      if (DEBUG) {
        console.error(`[DEBUG] Status: ${res.status}`);
        console.error(`[DEBUG] Body: ${text.slice(0, 2000)}`);
      }

      if (!res.ok) {
        lastError = { code: 'API_ERROR', message: `HTTP ${res.status}`, body: text.slice(0, 500) };
        if (res.status >= 500 && attempt < retries) {
          if (DEBUG) console.error(`[DEBUG] Server error, retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        if (throwOnFail) throw lastError;
        die('API_ERROR', `HTTP ${res.status}`, { body: text.slice(0, 500) });
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        if (throwOnFail) throw { code: 'API_ERROR', message: 'JSON 파싱 실패', body: text.slice(0, 500) };
        die(
          'API_ERROR',
          '응답이 JSON 이 아닙니다. DATA_GO_KR_API_KEY 가 유효한지, 해당 서비스가 활용 신청되어 있는지 확인하세요.',
          { body: text.slice(0, 500) },
        );
      }

      const header = json?.response?.header;
      if (header && header.resultCode && header.resultCode !== '00' && header.resultCode !== '0') {
        if (throwOnFail) throw { code: 'API_ERROR', message: `${header.resultMsg || 'Unknown'} (code=${header.resultCode})` };
        die('API_ERROR', `${header.resultMsg || 'Unknown'} (code=${header.resultCode})`);
      }

      return json;
    } catch (err) {
      if (err && err.code === 'API_ERROR') {
        lastError = err;
        if (throwOnFail && attempt >= retries) throw err;
      } else {
        lastError = { code: 'NETWORK_ERROR', message: err?.message || String(err) };
        if (attempt < retries) {
          if (DEBUG) console.error(`[DEBUG] Network error, retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        if (throwOnFail) throw lastError;
        die('NETWORK_ERROR', lastError.message);
      }
    }
  }
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function resolveLocation(positional, flags) {
  if (flags.lat !== undefined && flags.lon !== undefined) {
    const lat = Number(flags.lat);
    const lon = Number(flags.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      die('USAGE', '--lat 과 --lon 은 숫자여야 합니다.');
    }
    const { nx, ny } = latLonToGrid(lat, lon);
    return { lat, lon, label: `${lat},${lon}`, nx, ny };
  }
  const label = positional.join(' ').trim();
  if (!label) {
    die('USAGE', '지명 또는 --lat/--lon 이 필요합니다.');
  }
  const coords = LOCATIONS[label];
  if (!coords) {
    die(
      'UNKNOWN_LOCATION',
      `'${label}' 은 등록되지 않은 지명입니다. --lat/--lon 으로 호출하거나 kakao-map 으로 좌표 변환 후 재시도 하세요.`,
    );
  }
  const [lat, lon] = coords;
  const { nx, ny } = latLonToGrid(lat, lon);
  return { lat, lon, label, nx, ny };
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdNow(args) {
  const { flags, positional } = parseArgs(args);
  const loc = resolveLocation(positional, flags);
  const { base_date, base_time } = ultraNcstBaseTime();

  let data;
  try {
    data = await apiGet(VILAGE_BASE, '/getUltraSrtNcst', {
      pageNo: 1,
      numOfRows: 100,
      dataType: 'JSON',
      base_date,
      base_time,
      nx: loc.nx,
      ny: loc.ny,
    }, { throwOnFail: true });
  } catch (err) {
    const searchQuery = `${loc.label} 날씨 현재 기온`;
    out({
      fallback: true,
      reason: err?.message || 'API 호출 실패',
      command: 'now',
      location: loc.label,
      search_query: searchQuery,
      instruction: `기상청 API 장애로 데이터를 가져올 수 없습니다. 웹검색으로 "${searchQuery}" 를 조회하여 현재 날씨 정보를 전달해주세요.`,
    });
    return;
  }

  const items = data?.response?.body?.items?.item || [];
  if (!items.length) die('NO_DATA', '초단기실황 응답에 데이터가 없습니다.');

  const byCat = {};
  for (const it of items) byCat[it.category] = it.obsrValue;

  const ptyCode = Number(byCat.PTY ?? 0);
  const vecDeg = toNum(byCat.VEC);

  out({
    base_date,
    base_time,
    location: loc.label,
    grid: { nx: loc.nx, ny: loc.ny },
    temperature_c: toNum(byCat.T1H),
    humidity_pct: toNum(byCat.REH),
    precipitation_mm: parsePcp(byCat.RN1),
    precipitation_type: PTY_MAP_ULTRA[ptyCode] || '없음',
    wind_speed_ms: toNum(byCat.WSD),
    wind_direction: vecToDirection(vecDeg),
    wind_direction_deg: vecDeg,
  });
}

async function cmdForecast(args) {
  const { flags, positional } = parseArgs(args);
  const loc = resolveLocation(positional, flags);
  const days = Math.max(1, Math.min(3, parseInt(flags.days || '3', 10) || 3));
  const { base_date, base_time } = vilageFcstBaseTime();

  let data;
  try {
    data = await apiGet(VILAGE_BASE, '/getVilageFcst', {
      pageNo: 1,
      numOfRows: 1000,
      dataType: 'JSON',
      base_date,
      base_time,
      nx: loc.nx,
      ny: loc.ny,
    }, { throwOnFail: true });
  } catch (err) {
    const searchQuery = `${loc.label} 날씨 예보 ${days}일`;
    out({
      fallback: true,
      reason: err?.message || 'API 호출 실패',
      command: 'forecast',
      location: loc.label,
      search_query: searchQuery,
      instruction: `기상청 API 장애로 데이터를 가져올 수 없습니다. 웹검색으로 "${searchQuery}" 를 조회하여 날씨 예보 정보를 전달해주세요.`,
    });
    return;
  }

  const items = data?.response?.body?.items?.item || [];
  if (!items.length) die('NO_DATA', '단기예보 응답에 데이터가 없습니다.');

  // Group: fcstDate → fcstTime → { category: value }
  const byDate = {};
  for (const it of items) {
    const d = it.fcstDate;
    const t = it.fcstTime;
    if (!byDate[d]) byDate[d] = {};
    if (!byDate[d][t]) byDate[d][t] = {};
    byDate[d][t][it.category] = it.fcstValue;
  }

  const dateKeys = Object.keys(byDate).sort().slice(0, days);
  const resultDays = dateKeys.map((d) => {
    const times = Object.keys(byDate[d]).sort();
    let min = null;
    let max = null;
    for (const t of times) {
      const row = byDate[d][t];
      if (row.TMN !== undefined) min = toNum(row.TMN);
      if (row.TMX !== undefined) max = toNum(row.TMX);
    }
    // 3시간 간격 샘플링
    const hours = times
      .filter((t) => Number(t.slice(0, 2)) % 3 === 0)
      .map((t) => {
        const row = byDate[d][t];
        const vec = toNum(row.VEC);
        return {
          time: `${t.slice(0, 2)}:${t.slice(2)}`,
          temperature_c: toNum(row.TMP),
          sky: SKY_MAP[Number(row.SKY)] || null,
          precipitation_type: PTY_MAP_SHORT[Number(row.PTY ?? 0)] || '없음',
          pop_pct: toNum(row.POP),
          precipitation_mm: parsePcp(row.PCP),
          humidity_pct: toNum(row.REH),
          wind_speed_ms: toNum(row.WSD),
          wind_direction: vecToDirection(vec),
        };
      });
    return {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`,
      min_c: min,
      max_c: max,
      hours,
    };
  });

  out({
    base_date,
    base_time,
    location: loc.label,
    grid: { nx: loc.nx, ny: loc.ny },
    days: resultDays,
  });
}

async function cmdMid(args) {
  const { positional } = parseArgs(args);
  const region = positional.join(' ').trim();
  if (!region) die('USAGE', 'Usage: kma-weather mid <region>');

  const landCode = MID_LAND_REGIONS[region];
  const tempCode = MID_TEMP_REGIONS[region];
  if (!landCode || !tempCode) {
    die(
      'UNKNOWN_REGION',
      `'${region}' 은 중기예보 지원 지역이 아닙니다. 지원: ${Object.keys(MID_TEMP_REGIONS).join(', ')}`,
    );
  }

  const tmFc = midForecastTmFc();
  let landData, tempData;
  try {
    [landData, tempData] = await Promise.all([
      apiGet(MID_BASE, '/getMidLandFcst', {
        pageNo: 1,
        numOfRows: 10,
        dataType: 'JSON',
        regId: landCode,
        tmFc,
      }, { throwOnFail: true }),
      apiGet(MID_BASE, '/getMidTa', {
        pageNo: 1,
        numOfRows: 10,
        dataType: 'JSON',
        regId: tempCode,
        tmFc,
      }, { throwOnFail: true }),
    ]);
  } catch (err) {
    const searchQuery = `${region} 날씨 주간예보`;
    out({
      fallback: true,
      reason: err?.message || 'API 호출 실패',
      command: 'mid',
      location: region,
      search_query: searchQuery,
      instruction: `기상청 API 장애로 데이터를 가져올 수 없습니다. 웹검색으로 "${searchQuery}" 를 조회하여 중기예보 정보를 전달해주세요.`,
    });
    return;
  }

  const land = landData?.response?.body?.items?.item?.[0];
  const temp = tempData?.response?.body?.items?.item?.[0];
  if (!land || !temp) die('NO_DATA', '중기예보 응답에 데이터가 없습니다.');

  const days = [];
  for (let n = 3; n <= 10; n++) {
    const day = { day_offset: n };
    if (n <= 7) {
      day.am_sky = land[`wf${n}Am`] ?? null;
      day.am_pop_pct = toNum(land[`rnSt${n}Am`]);
      day.pm_sky = land[`wf${n}Pm`] ?? null;
      day.pm_pop_pct = toNum(land[`rnSt${n}Pm`]);
    } else {
      day.am_sky = land[`wf${n}`] ?? null;
      day.am_pop_pct = toNum(land[`rnSt${n}`]);
      day.pm_sky = null;
      day.pm_pop_pct = null;
    }
    day.min_c = toNum(temp[`taMin${n}`]);
    day.max_c = toNum(temp[`taMax${n}`]);
    days.push(day);
  }

  out({
    tm_fc: tmFc,
    land_region: landCode,
    temp_region: tempCode,
    location: region,
    days,
  });
}

async function cmdAir(args) {
  const { flags, positional } = parseArgs(args);
  const sido = positional.join(' ').trim() || '전국';

  if (!AIR_SIDO.includes(sido)) {
    die(
      'UNKNOWN_REGION',
      `'${sido}' 은 대기질 조회 대상이 아닙니다. 지원: ${AIR_SIDO.join(', ')}`,
    );
  }

  let data;
  try {
    data = await apiGet(AIR_BASE, '/getCtprvnRltmMesureDnsty', {
      pageNo: 1,
      numOfRows: 200,
      returnType: 'json',
      sidoName: sido,
      ver: '1.0',
    }, { throwOnFail: true });
  } catch (err) {
    const station = flags.station || '';
    const searchQuery = station
      ? `${sido} ${station} 미세먼지 오늘 실시간`
      : `${sido} 미세먼지 오늘 실시간`;
    out({
      fallback: true,
      reason: err?.message || 'API 호출 실패',
      sido,
      search_query: searchQuery,
      instruction: `에어코리아 API 장애로 데이터를 가져올 수 없습니다. 웹검색으로 "${searchQuery}" 를 조회하여 미세먼지 정보를 전달해주세요.`,
    });
    return;
  }

  // returnType=json 일 때 body.items 는 배열. 방어적으로 body.items.item 도 지원.
  let rawItems = data?.response?.body?.items;
  if (rawItems && !Array.isArray(rawItems) && Array.isArray(rawItems.item)) {
    rawItems = rawItems.item;
  }
  if (!Array.isArray(rawItems) || !rawItems.length) {
    die('NO_DATA', `${sido} 대기질 응답에 데이터가 없습니다.`);
  }

  let items = rawItems;
  if (flags.station) {
    const q = String(flags.station);
    items = items.filter((it) => (it.stationName || '').includes(q));
    if (!items.length) die('NO_DATA', `'${q}' 을 포함하는 측정소가 없습니다.`);
  }

  const stations = items.map((it) => ({
    station: it.stationName || null,
    data_time: it.dataTime || null,
    pm10: toNum(it.pm10Value),
    pm10_grade: GRADE_MAP[Number(it.pm10Grade)] || '점검중',
    pm25: toNum(it.pm25Value),
    pm25_grade: GRADE_MAP[Number(it.pm25Grade)] || '점검중',
    khai: toNum(it.khaiValue),
    khai_grade: GRADE_MAP[Number(it.khaiGrade)] || '점검중',
    o3: toNum(it.o3Value),
    no2: toNum(it.no2Value),
    co: toNum(it.coValue),
    so2: toNum(it.so2Value),
  }));

  out({ sido, count: stations.length, stations });
}

// ─── Help ───────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`kma-weather — 한국 기상청 날씨 + 에어코리아 미세먼지 CLI

Commands:
  now <location|--lat LAT --lon LON>              현재 실황 (초단기)
  forecast <location|--lat LAT --lon LON> [--days 1|2|3]   단기예보 3일
  mid <region>                                     중기예보 3~10일
  air <sido> [--station NAME]                      미세먼지/대기질

Options:
  --debug    raw HTTP 요청/응답을 stderr 로 출력

Environment:
  DATA_GO_KR_API_KEY  공공데이터포털 일반 인증키 (디코딩된 키)

Examples:
  kma-weather now "서울 강남구"
  kma-weather now --lat 37.5665 --lon 126.9780
  kma-weather forecast "부산" --days 2
  kma-weather mid 서울
  kma-weather air 서울 --station 강남
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (!API_KEY) {
  die(
    'NO_API_KEY',
    'DATA_GO_KR_API_KEY 환경변수가 없습니다. 호스트 .env 에 추가 후 컨테이너 재빌드 필요.',
  );
}

const rawArgs = process.argv.slice(2).filter((a) => a !== '--debug');
const [command, ...cmdArgs] = rawArgs;

try {
  switch (command) {
    case 'now':
      await cmdNow(cmdArgs);
      break;
    case 'forecast':
      await cmdForecast(cmdArgs);
      break;
    case 'mid':
      await cmdMid(cmdArgs);
      break;
    case 'air':
      await cmdAir(cmdArgs);
      break;
    case '--help':
    case '-h':
    case 'help':
    case undefined:
      printHelp();
      break;
    default:
      die('USAGE', `Unknown command: ${command}. Run with --help for usage.`);
  }
} catch (e) {
  die('UNEXPECTED', e && e.message ? e.message : String(e));
}
