// ============================================================================
// First-party collector — Baltimore/Washington International Thurgood Marshall
// (BWI). MDOT / Maryland Aviation Administration.
//
// Feed: the wait numbers BWI publishes on its OWN homepage (bwiairport.com) are
// rendered client-side from the theme's own AJAX endpoint:
//   POST https://bwiairport.com/wp-content/themes/bwitheme/ajaxcall.php
//        ?action=get_waitTimes_data      body: themeRootDir=<theme root>
// This is the airport's OWN public endpoint. It requires NO nonce and NO secret
// of ours — it is the same unauthenticated call the public homepage makes (the
// homepage does `$.post(THEMEROOTDIR + 'ajaxcall.php?action=get_waitTimes_data',
// {themeRootDir})`). robots.txt allows /wp-content/ (only /wp-admin/ is
// disallowed, with admin-ajax.php explicitly re-allowed). One request per run.
//
// Shape (verified live):
//   { waitTimes: { updated:"as of <time>3:15pm</time>",
//       waittimes: [ { Queue_Name:"Checkpoint A General",
//         Projected_Wait_Time:"4", Projected_Min_Wait_Minutes:"4",
//         Projected_Max_Wait_Minutes:"8", Queue_State:"Open"|"Closure",
//         Updated_Time:"2026-08-29T15:09:48", ... }, ... ] } }
//
// Queue_Name carries the checkpoint + lane, e.g. "Checkpoint A General",
// "Checkpoint DE PreCheck", "Checkpoint A Clear", "Checkpoint BC Priority".
//   - "General"  -> standard lane
//   - "PreCheck" -> TSA PreCheck lane
//   - "Clear" (CLEAR) / "Priority" (airline priority) -> neither; excluded from
//     both standardMin and precheckMin (they are not the standard TSA lane).
// Queue_State "Closure" => closed. We take Projected_Max_Wait_Minutes as the
// conservative upper bound of the reported range (falling back to
// Projected_Wait_Time), mirroring the PHX collector. Updated_Time has no
// timezone, so we use fetch time for observedAt rather than guess a zone.
// Zero deps — Node 20+ ESM.
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const AIRPORT = 'BWI';
const THEME_ROOT = 'https://bwiairport.com/wp-content/themes/bwitheme/';
const FEED_URL = `${THEME_ROOT}ajaxcall.php?action=get_waitTimes_data`;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The homepage calls this endpoint with POST; a GET returns an empty body.
// ctx.fetchJson is GET-only (see src/cbp.mjs), so we need our own POST helper.
async function postForm(url, form, { timeoutMs = 20000 } = {}) {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://bwiairport.com/',
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} POST ${url}`);
  return res.json();
}

/** Coerce to a non-negative integer minute count, or null. */
function toIntMin(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Conservative (upper-bound) minutes for a queue: prefer the max of the
 *  reported range, fall back to the single projected value. */
function queueWaitMin(q) {
  const max = toIntMin(q?.Projected_Max_Wait_Minutes);
  if (max !== null) return max;
  return toIntMin(q?.Projected_Wait_Time);
}

const isGeneral = (name) => /\bgeneral\b/i.test(name);
const isPrecheck = (name) => /pre\s*-?\s*check/i.test(name);

export async function collect(ctx) {
  // The homepage POSTs form-encoded (no nonce needed); replicate it exactly.
  const data = await postForm(FEED_URL, { themeRootDir: THEME_ROOT });

  const queues = Array.isArray(data?.waitTimes?.waittimes) ? data.waitTimes.waittimes : null;
  if (!queues) throw new Error(`BWI feed shape unexpected: ${typeof data}`);

  const standardLanes = []; // { name, waitMin, status }
  const preLanes = [];      // { name, waitMin, status }

  for (const q of queues) {
    const name = typeof q?.Queue_Name === 'string' ? q.Queue_Name.trim() : '';
    if (!name) {
      ctx.log(`bwi: skipping queue with no Queue_Name: ${JSON.stringify(q)}`);
      continue;
    }
    const open = !/closure|closed/i.test(String(q?.Queue_State ?? ''));
    const waitMin = open ? queueWaitMin(q) : null;
    const row = { name, waitMin, status: open ? 'Open' : 'Closed' };

    if (isPrecheck(name)) preLanes.push(row);
    else if (isGeneral(name)) standardLanes.push(row);
    // Clear / Priority lanes are intentionally ignored.
  }

  if (standardLanes.length === 0) {
    throw new Error('bwi: no General (standard) lanes in feed');
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
  // null if PreCheck not present in the feed at all.
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
