#!/usr/bin/env node

/**
 * kakao-map — Kakao Map directions & place search CLI.
 * Zero external dependencies. Uses Node.js 22 built-in fetch().
 *
 * Environment variables:
 *   KAKAO_REST_API_KEY — Kakao REST API key from developers.kakao.com
 *
 * Usage:
 *   node kakao-map.mjs search <query> [--x LNG] [--y LAT]
 *   node kakao-map.mjs address <query>
 *   node kakao-map.mjs reverse-geocode --x LNG --y LAT
 *   node kakao-map.mjs directions --origin LNG,LAT --dest LNG,LAT [--priority RECOMMEND|TIME|DISTANCE]
 *   node kakao-map.mjs route-url --origin-name NAME --origin-lat LAT --origin-lng LNG --dest-name NAME --dest-lat LAT --dest-lng LNG --mode FOOT|PUBLICTRANSIT|BICYCLE|CAR
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.KAKAO_REST_API_KEY;
const LOCAL_BASE = 'https://dapi.kakao.com';
const NAVI_BASE = 'https://apis-navi.kakaomobility.com';
const DEBUG = process.argv.includes('--debug');

function die(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

if (!API_KEY) {
  die('KAKAO_REST_API_KEY environment variable is required.');
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function kakaoGet(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  if (DEBUG) console.error(`[DEBUG] GET ${url}`);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `KakaoAK ${API_KEY}` },
  });

  const json = await res.json();

  if (DEBUG) {
    console.error(`[DEBUG] Status: ${res.status}`);
    console.error(`[DEBUG] Response: ${JSON.stringify(json).slice(0, 2000)}`);
  }

  if (!res.ok) {
    die(`API error ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSearch(args) {
  const query = args.filter((a) => !a.startsWith('--'))[0];
  if (!query) die('Usage: kakao-map search <query> [--x LNG] [--y LAT]');

  const parsed = parseArgs(args, ['x', 'y', 'size']);
  const params = { query, size: parsed.size || 5 };
  if (parsed.x) params.x = parsed.x;
  if (parsed.y) params.y = parsed.y;
  if (parsed.x && parsed.y) params.sort = 'distance';

  const data = await kakaoGet(LOCAL_BASE, '/v2/local/search/keyword.json', params);

  const places = data.documents.map((d) => ({
    name: d.place_name,
    address: d.address_name,
    road_address: d.road_address_name || null,
    x: d.x,
    y: d.y,
    phone: d.phone || null,
    category: d.category_name || null,
  }));

  console.log(JSON.stringify({ count: places.length, places }, null, 2));
}

async function cmdAddress(args) {
  const query = args.filter((a) => !a.startsWith('--'))[0];
  if (!query) die('Usage: kakao-map address <query>');

  const data = await kakaoGet(LOCAL_BASE, '/v2/local/search/address.json', { query });

  if (!data.documents.length) {
    die(`No results found for address: ${query}`);
  }

  const d = data.documents[0];
  console.log(JSON.stringify({
    address: d.address_name,
    x: d.x,
    y: d.y,
    address_type: d.address_type,
    road_address: d.road_address ? d.road_address.address_name : null,
  }, null, 2));
}

async function cmdReverseGeocode(args) {
  const parsed = parseArgs(args, ['x', 'y']);
  if (!parsed.x || !parsed.y) die('Usage: kakao-map reverse-geocode --x LNG --y LAT');

  const data = await kakaoGet(LOCAL_BASE, '/v2/local/geo/coord2address.json', {
    x: parsed.x,
    y: parsed.y,
  });

  if (!data.documents.length) {
    die(`No address found for coordinates: ${parsed.x}, ${parsed.y}`);
  }

  const d = data.documents[0];
  console.log(JSON.stringify({
    address: d.address ? d.address.address_name : null,
    road_address: d.road_address ? d.road_address.address_name : null,
    x: parsed.x,
    y: parsed.y,
  }, null, 2));
}

async function cmdDirections(args) {
  const parsed = parseArgs(args, ['origin', 'dest', 'priority']);
  if (!parsed.origin || !parsed.dest) {
    die('Usage: kakao-map directions --origin LNG,LAT --dest LNG,LAT [--priority RECOMMEND|TIME|DISTANCE]');
  }

  const params = {
    origin: parsed.origin,
    destination: parsed.dest,
    priority: parsed.priority || 'RECOMMEND',
  };

  const data = await kakaoGet(NAVI_BASE, '/v1/directions', params);

  if (!data.routes || !data.routes.length) {
    die('No route found.');
  }

  const route = data.routes[0];
  if (route.result_code !== 0) {
    die(`Route error: ${route.result_msg} (code: ${route.result_code})`);
  }

  const summary = route.summary;
  const result = {
    summary: {
      distance_km: Math.round((summary.distance / 1000) * 10) / 10,
      duration_min: Math.round(summary.duration / 60),
      taxi_fare: summary.fare?.taxi || 0,
      toll_fare: summary.fare?.toll || 0,
    },
    steps: [],
  };

  // Extract turn-by-turn guides from all sections
  let stepNum = 0;
  for (const section of route.sections || []) {
    for (const guide of section.guides || []) {
      if (!guide.guidance) continue;
      stepNum++;
      result.steps.push({
        step: stepNum,
        instruction: guide.guidance,
        road: guide.name || null,
        distance_m: guide.distance || 0,
        duration_s: guide.duration || 0,
      });
    }
  }

  result.step_count = result.steps.length;
  console.log(JSON.stringify(result, null, 2));
}

function cmdRouteUrl(args) {
  const parsed = parseArgs(args, [
    'origin-name', 'origin-lat', 'origin-lng',
    'dest-name', 'dest-lat', 'dest-lng',
    'mode',
  ]);

  if (!parsed['origin-lat'] || !parsed['origin-lng'] || !parsed['dest-lat'] || !parsed['dest-lng']) {
    die('Usage: kakao-map route-url --origin-name NAME --origin-lat LAT --origin-lng LNG --dest-name NAME --dest-lat LAT --dest-lng LNG --mode FOOT|PUBLICTRANSIT|BICYCLE|CAR');
  }

  const mode = (parsed.mode || 'CAR').toUpperCase();
  const validModes = ['FOOT', 'PUBLICTRANSIT', 'BICYCLE', 'CAR'];
  if (!validModes.includes(mode)) {
    die(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
  }

  const oLat = parsed['origin-lat'];
  const oLng = parsed['origin-lng'];
  const dLat = parsed['dest-lat'];
  const dLng = parsed['dest-lng'];
  const oName = parsed['origin-name'] || '';
  const dName = parsed['dest-name'] || '';

  // kakaomap:// URL uses lat,lng order
  const appUrl = `kakaomap://route?sp=${oLat},${oLng}&ep=${dLat},${dLng}&by=${mode}`
    + (oName ? `&sn=${encodeURIComponent(oName)}` : '')
    + (dName ? `&en=${encodeURIComponent(dName)}` : '');

  // Web URL uses name,lat,lng in path segments
  const fromPart = oName
    ? `${encodeURIComponent(oName)},${oLat},${oLng}`
    : `출발지,${oLat},${oLng}`;
  const toPart = dName
    ? `${encodeURIComponent(dName)},${dLat},${dLng}`
    : `도착지,${dLat},${dLng}`;
  const webUrl = `https://map.kakao.com/link/from/${fromPart}/to/${toPart}`;

  console.log(JSON.stringify({ mode, app_url: appUrl, web_url: webUrl }, null, 2));
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(args, keys) {
  const result = {};
  for (const key of keys) {
    const idx = args.indexOf(`--${key}`);
    if (idx >= 0 && idx + 1 < args.length) {
      result[key] = args[idx + 1];
    }
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2).filter((a) => a !== '--debug');

switch (command) {
  case 'search':
    await cmdSearch(args);
    break;
  case 'address':
    await cmdAddress(args);
    break;
  case 'reverse-geocode':
    await cmdReverseGeocode(args);
    break;
  case 'directions':
    await cmdDirections(args);
    break;
  case 'route-url':
    cmdRouteUrl(args);
    break;
  default:
    console.log(`kakao-map — Kakao Map directions & place search CLI

Commands:
  search <query> [--x LNG] [--y LAT]          Keyword place search
  address <query>                               Address to coordinates
  reverse-geocode --x LNG --y LAT             Coordinates to address
  directions --origin LNG,LAT --dest LNG,LAT  Car directions (detailed)
  route-url --origin-lat LAT --origin-lng LNG  Generate KakaoMap URL
            --dest-lat LAT --dest-lng LNG
            --mode FOOT|PUBLICTRANSIT|BICYCLE|CAR

Options:
  --debug    Show raw HTTP requests/responses

Notes:
  - Kakao APIs use x=longitude, y=latitude (lng,lat order)
  - KakaoMap URLs use lat,lng order (reversed)
  - Car directions only via REST API; walk/transit/bike via KakaoMap URL + browser
`);
    break;
}
