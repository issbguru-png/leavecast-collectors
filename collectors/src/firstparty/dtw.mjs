// ============================================================================
// First-party collector — Detroit Metropolitan Wayne County (DTW).
// Feed: https://proxy.metroairport.com/SkyFiiTSAProxy.ashx (open JSON).
// Shape (verified live): a flat array of checkpoint objects, e.g.
//   [{"Name":"Evans","WaitTime":10},{"Name":"McNamara","WaitTime":3}]
// Name = checkpoint name, WaitTime = wait in minutes. The feed carries no
// PreCheck distinction and no timestamp, so precheckOpen is null and
// observedAt is the fetch time. Emits one 'security_wait' reading for DTW.
// Zero deps — Node 20+ ESM.
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const AIRPORT = 'DTW';
const FEED_URL = 'https://proxy.metroairport.com/SkyFiiTSAProxy.ashx';
// This feed rejects the default collector UA; present a browser UA.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Coerce a WaitTime value to a non-negative integer minute count, or null. */
function toWaitMin(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export async function collect(ctx) {
  const data = await ctx.fetchJson(FEED_URL, { headers: { 'user-agent': BROWSER_UA } });

  const entries = Array.isArray(data) ? data : Array.isArray(data?.checkpoints) ? data.checkpoints : null;
  if (!entries) throw new Error(`DTW feed shape unexpected: ${typeof data}`);

  const checkpoints = [];
  let standardMin = null;
  for (const e of entries) {
    const name = typeof e?.Name === 'string' ? e.Name.trim() : '';
    if (!name) {
      ctx.log(`DTW: skipping checkpoint with no Name: ${JSON.stringify(e)}`);
      continue;
    }
    const waitMin = toWaitMin(e?.WaitTime);
    checkpoints.push({ name, waitMin, status: 'Open' });
    if (waitMin !== null) standardMin = standardMin === null ? waitMin : Math.max(standardMin, waitMin);
  }

  return [{
    source: 'firstparty',
    airport: AIRPORT,
    kind: 'security_wait',
    observedAt: nowIso(),
    payload: {
      standardMin,
      // DTW's SkyFii feed carries no PreCheck distinction — leave null, don't guess.
      precheckOpen: null,
      precheckMin: null,
      checkpoints,
    },
  }];
}
