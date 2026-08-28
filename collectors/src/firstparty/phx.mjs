// ============================================================================
// First-party collector — Phoenix Sky Harbor International (PHX).
// Feed: https://api.phx.aero/avn-wait-times/raw?Key=... (open JSON).
// Shape (verified live): { success, current: [ { queueName, projectedWaitTime,
//   projectedMinWaitMinutes, projectedMaxWaitMinutes, localTime, ... } ] }.
// queueName distinguishes lanes, e.g. "T3 General", "T4 Checkpoint A General",
// "T4 TSA PreCheck". projectedWaitTime is in seconds; the *WaitMinutes fields
// are minutes. Emits one 'security_wait' reading for PHX. Zero deps — Node 20+.
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const AIRPORT = 'PHX';
// PHX publishes this key in their own public wait-times page URL, so using it
// here is fine — it is not a secret credential of ours.
const PHX_PUBLIC_KEY = '4f85fe2ef5a240d59809b63de94ef536';
const FEED_URL = `https://api.phx.aero/avn-wait-times/raw?Key=${PHX_PUBLIC_KEY}`;

/** Coerce to a non-negative integer minute count, or null. */
function toIntMin(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** True if the queue name marks a PreCheck lane (case-insensitive). */
function isPrecheck(name) {
  return /pre\s*-?\s*check/i.test(name);
}

/** Best-effort minutes for a General queue: prefer max minutes, else seconds/60. */
function generalWaitMin(q) {
  const max = toIntMin(q?.projectedMaxWaitMinutes);
  if (max !== null) return max;
  const secs = Number(q?.projectedWaitTime);
  return Number.isFinite(secs) && secs >= 0 ? Math.round(secs / 60) : null;
}

export async function collect(ctx) {
  const data = await ctx.fetchJson(FEED_URL);

  const queues = Array.isArray(data?.current) ? data.current : Array.isArray(data) ? data : null;
  if (!queues) throw new Error(`PHX feed shape unexpected: ${typeof data}`);

  const general = [];
  const precheckWaits = [];
  let precheckSeen = false;
  let observedAt = null;

  for (const q of queues) {
    const name = typeof q?.queueName === 'string' ? q.queueName.trim() : '';
    if (!name) {
      ctx.log(`PHX: skipping queue with no queueName: ${JSON.stringify(q)}`);
      continue;
    }
    if (observedAt === null && q?.localTime && !Number.isNaN(Date.parse(q.localTime))) {
      observedAt = new Date(q.localTime).toISOString();
    }
    if (isPrecheck(name)) {
      precheckSeen = true;
      const pw = generalWaitMin(q);
      if (pw !== null) precheckWaits.push(pw);
      continue;
    }
    general.push({ name, waitMin: generalWaitMin(q), status: 'Open' });
  }

  let standardMin = null;
  for (const c of general) {
    if (c.waitMin !== null) standardMin = standardMin === null ? c.waitMin : Math.max(standardMin, c.waitMin);
  }

  return [{
    source: 'firstparty',
    airport: AIRPORT,
    kind: 'security_wait',
    observedAt: observedAt ?? nowIso(),
    payload: {
      standardMin,
      precheckOpen: precheckSeen ? true : null,
      precheckMin: precheckWaits.length ? Math.max(...precheckWaits) : null,
      checkpoints: general,
    },
  }];
}
