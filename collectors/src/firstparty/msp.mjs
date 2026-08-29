// ============================================================================
// First-party collector — Minneapolis-St. Paul International (MSP).
// Metropolitan Airports Commission (mspairport.com, Drupal).
//
// Feed: MSP renders its security wait numbers SERVER-SIDE, directly in the HTML
// of its own public page — no client-side JS and no JSON API are involved:
//   https://www.mspairport.com/airport/security-screening/security-wait-times
// robots.txt permits this path (only /admin/, /search/, /user/*, etc. are
// disallowed). The page carries a Cloudflare Turnstile widget, but it gates an
// unrelated form, NOT the wait-times content — a plain GET returns the numbers.
// Because the numbers are already in the served markup, a lightweight fetch +
// parse is the gentlest viable approach (no headless browser needed). One
// request per run. Zero deps — Node 20+ ESM.
//
// Markup contract (verified live):
//   <div id="block-waittimesblock" class="security-wait-times-block">
//     <h5 class="...__ticketing-level">Terminal 1</h5>
//     <div class="security-wait-time ...">
//       <div class="security-wait-time__inner">
//         <div class="...__checkpoint-name"><div>T1 North</div></div>
//         <div class="centering">
//           <div class="...__message">all passengers</div>          <- standard
//           <div class="...__time">Less than 10 minutes</div>
//         </div> ...
//   PreCheck lanes carry a __message of "PreCheck ..." (e.g. "PreCheck <div>MSP
//   Reserve</div>"); every other lane ("all passengers") is a standard lane.
//   __time is a human string ("Less than 10 minutes", "Less than 5 minutes",
//   or a Closed/no-number state). We take the largest number present as a
//   conservative upper bound ("Less than 10 minutes" -> 10).
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const AIRPORT = 'MSP';
const URL = 'https://www.mspairport.com/airport/security-screening/security-wait-times';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Largest minutes value present in a __time string, or null.
 *   "Less than 10 minutes" -> 10   "Less than 5 minutes" -> 5
 *   "Closed" / "" / no number -> null */
function parseWaitTime(raw) {
  const s = String(raw || '').trim();
  if (!s || /closed/i.test(s)) return null;
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const max = Math.max(...nums.map(Number));
  return Number.isFinite(max) ? Math.round(max) : null;
}

/** Strip tags/entities from a captured HTML fragment to plain text. */
function textOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the server-rendered wait-times block into checkpoint rows.
 * Each checkpoint is one `security-wait-time__inner` segment.
 * @returns {Array<{name:string, lane:'standard'|'precheck', waitMin:number|null, status:'Open'|'Closed'}>}
 */
function parseCheckpoints(html) {
  const rows = [];
  // Split on the per-checkpoint wrapper so name/message/time never cross rows.
  const segments = html.split('security-wait-time__inner');
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const nameM = /__checkpoint-name"[^>]*>\s*<div[^>]*>([^<]+)<\/div>/i.exec(seg);
    if (!nameM) continue;
    const name = textOf(nameM[1]);
    if (!name) continue;

    const timeM = /__time"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
    const timeText = timeM ? textOf(timeM[1]) : '';

    const msgM = /__message"[^>]*>([\s\S]*?)<div class="[^"]*__time"/i.exec(seg);
    const msgText = msgM ? textOf(msgM[1]) : '';
    const lane = /pre\s*-?\s*check/i.test(msgText) ? 'precheck' : 'standard';

    const waitMin = parseWaitTime(timeText);
    const open = waitMin !== null;
    rows.push({ name, lane, waitMin, status: open ? 'Open' : 'Closed' });
  }
  return rows;
}

export async function collect(ctx) {
  const html = await ctx.fetchText(URL, {
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml',
      referer: 'https://www.mspairport.com/',
    },
  });

  if (!/security-wait-times-block|security-wait-time__/.test(html)) {
    // No wait block in the served HTML. Distinguish a bot-wall from a plain miss.
    if (/challenge-platform|cf-mitigated|Just a moment|Checking (if|your)/i.test(html)) {
      ctx.log('msp: wait-times block absent behind a Cloudflare interstitial (bot-walled); returning []');
    } else {
      ctx.log('msp: wait-times block not present in served HTML; returning []');
    }
    return [];
  }

  const rows = parseCheckpoints(html);
  if (rows.length === 0) {
    ctx.log('msp: wait-times block present but no checkpoints parsed; returning []');
    return [];
  }

  const standardLanes = rows.filter((r) => r.lane === 'standard');
  const preLanes = rows.filter((r) => r.lane === 'precheck');

  if (standardLanes.length === 0) {
    ctx.log('msp: no standard-lane checkpoints parsed; returning []');
    return [];
  }

  // standardMin = MAX over OPEN standard checkpoints (null if none open).
  const openStandard = standardLanes
    .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
    .map((c) => c.waitMin);
  const standardMin = openStandard.length ? Math.max(...openStandard) : null;

  // precheckMin = MAX over OPEN PreCheck checkpoints (null if none open).
  const openPre = preLanes
    .filter((c) => c.status === 'Open' && Number.isFinite(c.waitMin))
    .map((c) => c.waitMin);
  const precheckMin = openPre.length ? Math.max(...openPre) : null;

  // precheckOpen: true if any PreCheck lane open; false if present-but-closed;
  // null if no PreCheck lane is shown.
  let precheckOpen = null;
  if (preLanes.length) precheckOpen = preLanes.some((c) => c.status === 'Open');

  const checkpoints = standardLanes.map((c) => ({
    name: c.name, waitMin: c.waitMin, status: c.status,
  }));

  return [{
    source: 'firstparty',
    airport: AIRPORT,
    kind: 'security_wait',
    observedAt: nowIso(),
    payload: { standardMin, precheckOpen, precheckMin, checkpoints },
  }];
}
