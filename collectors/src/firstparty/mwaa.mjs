// ============================================================================
// MWAA first-party security-wait collector — Metropolitan Washington Airports
// Authority. Covers DCA (Reagan National) and IAD (Dulles).
// Feeds (open JSON, no key):
//   DCA: https://www.flyreagan.com/security-wait-times
//   IAD: https://www.flydulles.com/security-wait-times
// Both return { response: { res: { <letter>: { location, waittime, gates?,
//   gcolor?, pre_disabled?, ... } }, header } }. `waittime` is a human STRING
// ("< 5 mins", "10 - 20 mins", "15 mins", "Closed", ""). No upstream timestamp,
// so we use fetch time. Zero deps — Node 20+ ESM.
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const AIRPORTS = [
  { iata: 'DCA', url: 'https://www.flyreagan.com/security-wait-times', origin: 'https://www.flyreagan.com' },
  { iata: 'IAD', url: 'https://www.flydulles.com/security-wait-times', origin: 'https://www.flydulles.com' },
];

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Parse a human wait-time string into a conservative (max) minutes number.
 *   "< 5 mins"      -> 5   (upper bound)
 *   "10 - 20 mins"  -> 20  (max of the range)
 *   "15 mins"       -> 15
 *   "Closed" / "" / non-numeric -> null
 * @returns {number|null}
 */
function parseWaitTime(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/closed/i.test(s)) return null;
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  // Range or single value: always take the largest number present.
  const max = Math.max(...nums.map(Number));
  return Number.isFinite(max) ? Math.round(max) : null;
}

/**
 * Derive precheckOpen from a checkpoint's pre_disabled field.
 *   pre_disabled truthy (1/true)  => precheck closed => false
 *   pre_disabled falsy   (0/false) => precheck open   => true
 *   field absent                   => null (unknown)
 * @returns {boolean|null}
 */
function precheckFromDisabled(cp) {
  if (cp == null || !Object.prototype.hasOwnProperty.call(cp, 'pre_disabled')) return null;
  const v = cp.pre_disabled;
  if (v === null || v === undefined) return null;
  // Accept 0/1, "0"/"1", true/false.
  const disabled = v === true || v === 1 || v === '1';
  return !disabled;
}

/** Build one 'security_wait' Reading from a fetched airport payload. */
function toReading(iata, json) {
  const res = json?.response?.res;
  if (!res || typeof res !== 'object') {
    throw new Error(`${iata}: unexpected shape (missing response.res)`);
  }

  const checkpoints = [];
  const waitMins = [];
  let precheckOpen = null; // stays null unless any checkpoint reports pre_disabled

  for (const [key, cp] of Object.entries(res)) {
    if (!cp || typeof cp !== 'object') continue;
    const waitMin = parseWaitTime(cp.waittime);
    const name = (typeof cp.location === 'string' && cp.location.trim())
      ? cp.location.trim()
      : `Checkpoint ${key}`;
    checkpoints.push({ name, waitMin, status: waitMin == null ? 'Closed' : 'Open' });
    if (waitMin != null) waitMins.push(waitMin);

    const pre = precheckFromDisabled(cp);
    if (pre !== null) {
      // If any checkpoint offers precheck, treat the airport as precheck-open.
      precheckOpen = precheckOpen === true ? true : pre;
    }
  }

  if (checkpoints.length === 0) {
    throw new Error(`${iata}: no checkpoints in response.res`);
  }

  const standardMin = waitMins.length ? Math.max(...waitMins) : null;

  // No upstream timestamp is present in either feed; use fetch time.
  const observedAt =
    typeof json?.response?.observedAt === 'string' ? json.response.observedAt
    : typeof json?.response?.timestamp === 'string' ? json.response.timestamp
    : nowIso();

  return {
    source: 'firstparty',
    airport: iata,
    kind: 'security_wait',
    observedAt,
    payload: { standardMin, precheckOpen, checkpoints },
  };
}

export async function collect(ctx) {
  const readings = [];
  const errors = [];

  for (const { iata, url, origin } of AIRPORTS) {
    try {
      const json = await ctx.fetchJson(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/json', referer: `${origin}/` },
      });
      readings.push(toReading(iata, json));
    } catch (err) {
      errors.push(iata);
      ctx.log(`mwaa: skipping ${iata}: ${err.message}`);
    }
  }

  if (readings.length === 0) {
    throw new Error(`mwaa: all airports failed (${errors.join(', ') || 'none'})`);
  }

  return readings;
}
