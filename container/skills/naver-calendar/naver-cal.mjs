#!/usr/bin/env node

/**
 * naver-cal — CalDAV wrapper for Naver Calendar.
 * Zero external dependencies. Uses Node.js 22 built-in fetch().
 *
 * Environment variables:
 *   NAVER_CALDAV_USER     — Naver ID
 *   NAVER_CALDAV_PASSWORD — App-specific password (2FA required)
 *
 * Usage:
 *   node naver-cal.mjs list [--from DATE] [--to DATE]
 *   node naver-cal.mjs get <UID>
 *   node naver-cal.mjs create --title TITLE --start DATETIME [--end DATETIME] [--description DESC] [--location LOC]
 *   node naver-cal.mjs update <UID> [--title T] [--start DT] [--end DT] [--description D] [--location L]
 *   node naver-cal.mjs delete <UID>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────────────────────

const CALDAV_USER = process.env.NAVER_CALDAV_USER;
const CALDAV_PASS = process.env.NAVER_CALDAV_PASSWORD;
const CALDAV_HOST = 'https://caldav.calendar.naver.com';
const DEBUG = process.argv.includes('--debug');
const CONFIG_PATH =
  join(process.env.WORKSPACE_GROUP || '/workspace/group', '.naver-cal-config.json');

function authHeader() {
  return 'Basic ' + Buffer.from(`${CALDAV_USER}:${CALDAV_PASS}`).toString('base64');
}

function die(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

if (!CALDAV_USER || !CALDAV_PASS) {
  die('NAVER_CALDAV_USER and NAVER_CALDAV_PASSWORD environment variables are required.');
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function caldavRequest(method, url, body, extraHeaders = {}) {
  const headers = {
    Authorization: authHeader(),
    ...extraHeaders,
  };
  if (body) headers['Content-Type'] = extraHeaders['Content-Type'] || 'application/xml; charset=utf-8';

  if (DEBUG) {
    console.error(`[DEBUG] ${method} ${url}`);
    if (body) console.error(`[DEBUG] Body:\n${body}`);
  }

  const res = await fetch(url, { method, headers, body });

  const text = await res.text();
  if (DEBUG) {
    console.error(`[DEBUG] Status: ${res.status}`);
    console.error(`[DEBUG] Response:\n${text.slice(0, 2000)}`);
  }

  return { status: res.status, headers: res.headers, text };
}

// ─── Calendar discovery ──────────────────────────────────────────────────────

async function discoverCalendarUrl() {
  // Direct URL override — skips discovery entirely when set.
  if (process.env.NAVER_CALDAV_URL) {
    return process.env.NAVER_CALDAV_URL;
  }

  // Check cache
  if (existsSync(CONFIG_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (cached.calendarUrl && cached.user === CALDAV_USER) return cached.calendarUrl;
    } catch { /* ignore */ }
  }

  // Step 1: Discover current-user-principal from root
  const rootPropfind = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;

  const res0 = await caldavRequest('PROPFIND', `${CALDAV_HOST}/`, rootPropfind, { Depth: '0' });
  if (res0.status !== 207) {
    die(`Calendar discovery failed (root). Status: ${res0.status}. Check credentials and 2FA app password.`);
  }

  const principalMatch = res0.text.match(/<(?:[a-z]+:)?current-user-principal[^>]*>\s*<(?:[a-z]+:)?href[^>]*>([^<]+)<\/(?:[a-z]+:)?href>/i);
  if (!principalMatch) {
    die('Could not find current-user-principal in root PROPFIND response.');
  }

  let principalUrl = principalMatch[1];
  if (!principalUrl.startsWith('http')) principalUrl = CALDAV_HOST + principalUrl;

  // Step 2: Find calendar-home-set from principal
  const homeSetBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <cal:calendar-home-set/>
  </d:prop>
</d:propfind>`;

  const res1 = await caldavRequest('PROPFIND', principalUrl, homeSetBody, { Depth: '0' });
  if (res1.status !== 207) {
    die(`Calendar discovery failed (principal). Status: ${res1.status}.`);
  }

  const homeMatch = res1.text.match(/<(?:[a-z]+:)?calendar-home-set[^>]*>\s*<(?:[a-z]+:)?href[^>]*>([^<]+)<\/(?:[a-z]+:)?href>/i);
  if (!homeMatch) {
    die('Could not find calendar-home-set in principal PROPFIND response.');
  }

  let homeUrl = homeMatch[1];
  if (!homeUrl.startsWith('http')) homeUrl = CALDAV_HOST + homeUrl;

  // Step 3: Find the default calendar in the home set
  const propfindCalendars = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
  </d:prop>
</d:propfind>`;

  const res2 = await caldavRequest('PROPFIND', homeUrl, propfindCalendars, { Depth: '1' });
  if (res2.status !== 207) {
    die(`Calendar discovery failed (home-set). Status: ${res2.status}`);
  }

  // Parse multistatus responses to find a calendar collection
  const responses = res2.text.split(/<(?:[a-z]+:)?response[^>]*>/i).slice(1);
  let calendarUrl = null;

  for (const resp of responses) {
    const isCalendar = /<(?:[a-z]+:)?calendar\s*\/>/i.test(resp);
    if (!isCalendar) continue;

    const hrefMatch = resp.match(/<(?:[a-z]+:)?href[^>]*>([^<]+)<\/(?:[a-z]+:)?href>/i);
    if (hrefMatch) {
      calendarUrl = hrefMatch[1];
      break;
    }
  }

  if (!calendarUrl) {
    die('No calendar collection found. Ensure you have at least one calendar in your Naver account.');
  }

  if (!calendarUrl.startsWith('http')) calendarUrl = CALDAV_HOST + calendarUrl;

  // Cache the result
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ user: CALDAV_USER, calendarUrl }));
  } catch { /* non-critical */ }

  return calendarUrl;
}

// ─── iCalendar helpers ───────────────────────────────────────────────────────

function toICalDate(dateStr) {
  // Accepts: "2026-03-28", "2026-03-28 14:00", "2026-03-28T14:00:00", etc.
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) die(`Invalid date: ${dateStr}`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toICalDateUTC(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) die(`Invalid date: ${dateStr}`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function nowPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function escapeICalText(text) {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function unescapeICalText(text) {
  return text.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function getTimezoneId() {
  return process.env.TZ || 'Asia/Seoul';
}

function buildVEvent({ uid, title, start, end, description, location }) {
  const tzid = getTimezoneId();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//naver-cal//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICalDateUTC(new Date().toISOString())}`,
    `DTSTART;TZID=${tzid}:${toICalDate(start)}`,
  ];
  if (end) {
    lines.push(`DTEND;TZID=${tzid}:${toICalDate(end)}`);
  } else {
    // Default: 1 hour duration
    const endDate = new Date(start);
    endDate.setHours(endDate.getHours() + 1);
    lines.push(`DTEND;TZID=${tzid}:${toICalDate(endDate.toISOString())}`);
  }
  lines.push(`SUMMARY:${escapeICalText(title)}`);
  if (description) lines.push(`DESCRIPTION:${escapeICalText(description)}`);
  if (location) lines.push(`LOCATION:${escapeICalText(location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function parseVEvents(icalText) {
  const events = [];
  const eventBlocks = icalText.split(/BEGIN:VEVENT/g).slice(1);

  for (const block of eventBlocks) {
    const raw = block.split(/END:VEVENT/)[0];
    const get = (key) => {
      // Match both simple and parameterized properties (e.g., DTSTART;TZID=...:value)
      const m = raw.match(new RegExp(`^${key}[;:]([^\\r\\n]+)`, 'mi'));
      if (!m) return null;
      // Strip parameters — value is after the last ':'
      const val = m[1];
      const colonIdx = val.lastIndexOf(':');
      return colonIdx >= 0 && m[0].includes(';') ? val.slice(colonIdx + 1).trim() : val.trim();
    };

    const uid = get('UID');
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    const dtend = get('DTEND');
    const description = get('DESCRIPTION');
    const location = get('LOCATION');

    events.push({
      uid: uid || null,
      title: summary ? unescapeICalText(summary) : null,
      start: dtstart || null,
      end: dtend || null,
      description: description ? unescapeICalText(description) : null,
      location: location ? unescapeICalText(location) : null,
    });
  }

  return events;
}

function formatDateForDisplay(icalDate) {
  if (!icalDate) return null;
  // e.g., 20260328T140000 → 2026-03-28 14:00
  const m = icalDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return icalDate;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdList(args) {
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  const fromDate = fromIdx >= 0 ? new Date(args[fromIdx + 1]) : todayStart();
  const toDate = toIdx >= 0 ? new Date(args[toIdx + 1]) : nowPlusDays(7);

  const calUrl = await discoverCalendarUrl();

  const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT">
        <cal:time-range start="${toICalDateUTC(fromDate.toISOString())}" end="${toICalDateUTC(toDate.toISOString())}"/>
      </cal:comp-filter>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>`;

  const res = await caldavRequest('REPORT', calUrl, reportBody, { Depth: '1' });
  if (res.status !== 207) {
    die(`Failed to list events. Status: ${res.status}`);
  }

  // Naver CalDAV may omit calendar-data in REPORT — fall back to individual GET requests.
  const allEvents = [];
  const calDataMatches = [...res.text.matchAll(/<(?:[a-z]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?calendar-data>/gi)];

  if (calDataMatches.length > 0) {
    for (const match of calDataMatches) {
      const ical = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      allEvents.push(...parseVEvents(ical));
    }
  } else {
    // Extract hrefs and fetch each event individually
    const hrefMatches = [...res.text.matchAll(/<(?:[a-z]+:)?href[^>]*>([^<]*\.ics)<\/(?:[a-z]+:)?href>/gi)];
    for (const m of hrefMatches) {
      let eventUrl = m[1];
      if (!eventUrl.startsWith('http')) eventUrl = CALDAV_HOST + eventUrl;
      const eventRes = await caldavRequest('GET', eventUrl, null);
      if (eventRes.status === 200) {
        allEvents.push(...parseVEvents(eventRes.text));
      }
    }
  }

  // Sort by start time
  allEvents.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  const result = allEvents.map((e) => ({
    uid: e.uid,
    title: e.title,
    start: formatDateForDisplay(e.start),
    end: formatDateForDisplay(e.end),
    location: e.location || null,
    description: e.description || null,
  }));

  console.log(JSON.stringify({ count: result.length, events: result }, null, 2));
}

async function cmdGet(args) {
  const uid = args[0];
  if (!uid) die('Usage: naver-cal get <EVENT_UID>');

  const calUrl = await discoverCalendarUrl();

  // Search for the event by UID
  const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT">
        <cal:prop-filter name="UID">
          <cal:text-match collation="i;octet">${uid}</cal:text-match>
        </cal:prop-filter>
      </cal:comp-filter>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>`;

  const res = await caldavRequest('REPORT', calUrl, reportBody, { Depth: '1' });
  if (res.status !== 207) {
    die(`Failed to get event. Status: ${res.status}`);
  }

  const calDataMatch = res.text.match(/<(?:[a-z]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?calendar-data>/i);
  if (!calDataMatch) {
    die(`Event not found: ${uid}`);
  }

  const ical = calDataMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const events = parseVEvents(ical);
  if (events.length === 0) die(`Event not found: ${uid}`);

  const e = events[0];
  console.log(JSON.stringify({
    uid: e.uid,
    title: e.title,
    start: formatDateForDisplay(e.start),
    end: formatDateForDisplay(e.end),
    location: e.location || null,
    description: e.description || null,
  }, null, 2));
}

async function cmdCreate(args) {
  const parsed = parseArgs(args, ['title', 'start', 'end', 'description', 'location']);
  if (!parsed.title || !parsed.start) {
    die('Usage: naver-cal create --title TITLE --start DATETIME [--end DATETIME] [--description DESC] [--location LOC]');
  }

  const uid = randomUUID();
  const calUrl = await discoverCalendarUrl();
  const eventUrl = `${calUrl.replace(/\/$/, '')}/${uid}.ics`;
  const ical = buildVEvent({ uid, ...parsed });

  const res = await caldavRequest('PUT', eventUrl, ical, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'If-None-Match': '*',
  });

  if (res.status < 200 || res.status >= 300) {
    die(`Failed to create event. Status: ${res.status}`);
  }

  console.log(JSON.stringify({
    success: true,
    uid,
    title: parsed.title,
    start: parsed.start,
    end: parsed.end || null,
  }, null, 2));
}

async function cmdUpdate(args) {
  const uid = args[0];
  if (!uid) die('Usage: naver-cal update <EVENT_UID> [--title T] [--start DT] [--end DT] [--description D] [--location L]');

  const updates = parseArgs(args.slice(1), ['title', 'start', 'end', 'description', 'location']);
  const calUrl = await discoverCalendarUrl();

  // Fetch current event
  const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT">
        <cal:prop-filter name="UID">
          <cal:text-match collation="i;octet">${uid}</cal:text-match>
        </cal:prop-filter>
      </cal:comp-filter>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>`;

  const res = await caldavRequest('REPORT', calUrl, reportBody, { Depth: '1' });
  if (res.status !== 207) die(`Failed to find event for update. Status: ${res.status}`);

  // Extract href and etag
  const hrefMatch = res.text.match(/<(?:[a-z]+:)?href[^>]*>([^<]*\.ics)<\/(?:[a-z]+:)?href>/i);
  const etagMatch = res.text.match(/<(?:[a-z]+:)?getetag[^>]*>"?([^"<]+)"?<\/(?:[a-z]+:)?getetag>/i);
  const calDataMatch = res.text.match(/<(?:[a-z]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?calendar-data>/i);

  if (!hrefMatch || !calDataMatch) die(`Event not found: ${uid}`);

  const eventHref = hrefMatch[1];
  const etag = etagMatch ? etagMatch[1] : null;
  const ical = calDataMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const existing = parseVEvents(ical)[0];

  if (!existing) die(`Could not parse existing event: ${uid}`);

  // Merge updates
  const merged = {
    uid,
    title: updates.title || existing.title,
    start: updates.start || formatDateForDisplay(existing.start),
    end: updates.end || formatDateForDisplay(existing.end),
    description: updates.description !== undefined ? updates.description : existing.description,
    location: updates.location !== undefined ? updates.location : existing.location,
  };

  const newIcal = buildVEvent(merged);
  let eventUrl = eventHref;
  if (!eventUrl.startsWith('http')) eventUrl = CALDAV_HOST + eventUrl;

  const putHeaders = { 'Content-Type': 'text/calendar; charset=utf-8' };
  if (etag) putHeaders['If-Match'] = `"${etag}"`;

  const putRes = await caldavRequest('PUT', eventUrl, newIcal, putHeaders);
  if (putRes.status < 200 || putRes.status >= 300) {
    die(`Failed to update event. Status: ${putRes.status}`);
  }

  console.log(JSON.stringify({
    success: true,
    uid,
    title: merged.title,
    start: merged.start,
    end: merged.end,
  }, null, 2));
}

async function cmdDelete(args) {
  const uid = args[0];
  if (!uid) die('Usage: naver-cal delete <EVENT_UID>');

  const calUrl = await discoverCalendarUrl();

  // Find the event URL
  const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
  </d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT">
        <cal:prop-filter name="UID">
          <cal:text-match collation="i;octet">${uid}</cal:text-match>
        </cal:prop-filter>
      </cal:comp-filter>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>`;

  const res = await caldavRequest('REPORT', calUrl, reportBody, { Depth: '1' });
  if (res.status !== 207) die(`Failed to find event for deletion. Status: ${res.status}`);

  const hrefMatch = res.text.match(/<(?:[a-z]+:)?href[^>]*>([^<]*\.ics)<\/(?:[a-z]+:)?href>/i);
  const etagMatch = res.text.match(/<(?:[a-z]+:)?getetag[^>]*>"?([^"<]+)"?<\/(?:[a-z]+:)?getetag>/i);

  if (!hrefMatch) die(`Event not found: ${uid}`);

  let eventUrl = hrefMatch[1];
  if (!eventUrl.startsWith('http')) eventUrl = CALDAV_HOST + eventUrl;

  const deleteHeaders = {};
  if (etagMatch) deleteHeaders['If-Match'] = `"${etagMatch[1]}"`;

  const delRes = await caldavRequest('DELETE', eventUrl, null, deleteHeaders);
  if (delRes.status < 200 || delRes.status >= 300) {
    die(`Failed to delete event. Status: ${delRes.status}`);
  }

  console.log(JSON.stringify({ success: true, deleted: uid }, null, 2));
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
  case 'list':
    await cmdList(args);
    break;
  case 'get':
    await cmdGet(args);
    break;
  case 'create':
    await cmdCreate(args);
    break;
  case 'update':
    await cmdUpdate(args);
    break;
  case 'delete':
    await cmdDelete(args);
    break;
  default:
    console.log(`naver-cal — Naver Calendar CLI (CalDAV)

Commands:
  list   [--from DATE] [--to DATE]    List events (default: today ~ 7 days)
  get    <UID>                         Get event details
  create --title T --start DT [...]   Create event
  update <UID> [--title T] [...]      Update event
  delete <UID>                         Delete event

Options:
  --debug    Show raw HTTP requests/responses

Dates: "2026-03-28", "2026-03-28 14:00", "2026-03-28T14:00:00"
`);
    break;
}
