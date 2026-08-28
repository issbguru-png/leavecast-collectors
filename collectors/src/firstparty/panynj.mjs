// ============================================================================
// Port Authority (PANYNJ) first-party security-wait collector — JFK, LGA, EWR.
// Feed: https://avi-prod-mpp-webapp-api.azurewebsites.net/api/v1/
//         SecurityWaitTimesPoints/{CODE}  (open, no key; needs an allowed
// Origin header — the airport sites are whitelisted, panynj.gov is not).
// Each item: { terminal, checkPoint, queueType ('Reg'|'TSAPre'), timeInMinutes,
// timeInSeconds, queueOpen, status, isWaitTimeAvailable, updateTime, ... }.
// Emits one 'security_wait' reading per airport. Zero deps. Never throws for a
// single airport — skip+log; throws only if all three feeds fail.
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const API = 'https://avi-prod-mpp-webapp-api.azurewebsites.net/api/v1/SecurityWaitTimesPoints';

// IATA -> allowed Origin (the endpoint 401s without a whitelisted one).
const AIRPORTS = {
  JFK: 'https://www.jfkairport.com',
  LGA: 'https://www.laguardiaairport.com',
  EWR: 'https://www.newarkairport.com',
};

/** Offset (localWallTime - UTC) in ms for `timeZone` at a given instant. */
function tzOffsetMs(timeZone, epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - epochMs;
}

/** The feed's updateTime is naive Eastern wall-clock (no offset) -> UTC epoch ms. */
function easternToEpoch(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const [Y, Mo, D, h, mi, se] = m.slice(1, 7).map(Number);
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  const guess = Date.UTC(Y, Mo - 1, D, h, mi, se, ms);
  if (Number.isNaN(guess)) return NaN;
  return guess - tzOffsetMs('America/New_York', guess);
}

const isReg = (r) => r?.queueType === 'Reg';
const isPre = (r) => r?.queueType === 'TSAPre';

function buildReading(code, rows) {
  // Representative standard-lane wait: MAX over open, available Reg queues.
  const regWaits = rows
    .filter((r) => isReg(r) && r.queueOpen === true && r.isWaitTimeAvailable === true)
    .map((r) => Number(r.timeInMinutes))
    .filter((n) => Number.isFinite(n));
  const standardMin = regWaits.length ? Math.max(...regWaits) : null;

  // PreCheck: any open TSAPre -> true; TSAPre present but all closed -> false; none -> null.
  const preRows = rows.filter(isPre);
  const precheckOpen = preRows.length ? preRows.some((r) => r.queueOpen === true) : null;
  const preWaits = preRows
    .filter((r) => r.queueOpen === true && r.isWaitTimeAvailable === true && Number.isFinite(Number(r.timeInMinutes)))
    .map((r) => Number(r.timeInMinutes));
  const precheckMin = preWaits.length ? Math.max(...preWaits) : null;

  // Checkpoints from the standard (Reg) lanes, exact-duplicate rows collapsed.
  const seen = new Set();
  const checkpoints = [];
  for (const r of rows.filter(isReg)) {
    const name = `${r.terminal ?? ''} ${r.checkPoint ?? ''}`.trim();
    const waitMin = r.isWaitTimeAvailable === true && Number.isFinite(Number(r.timeInMinutes))
      ? Number(r.timeInMinutes)
      : null;
    const status = r.queueOpen === true ? 'Open' : 'Closed';
    const key = `${name}|${waitMin}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checkpoints.push({ name, waitMin, status });
  }

  // Newest updateTime across the airport's rows -> ISO UTC; else fetch time.
  let newest = -Infinity;
  for (const r of rows) {
    const t = easternToEpoch(r.updateTime);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  const observedAt = Number.isFinite(newest) ? new Date(newest).toISOString() : nowIso();

  return {
    source: 'firstparty',
    airport: code,
    kind: 'security_wait',
    observedAt,
    payload: { standardMin, precheckOpen, precheckMin, checkpoints },
  };
}

export async function collect(ctx) {
  const codes = Object.keys(AIRPORTS);
  const readings = [];
  let failures = 0;

  for (const code of codes) {
    try {
      const origin = AIRPORTS[code];
      const data = await ctx.fetchJson(`${API}/${code}`, {
        headers: { origin, referer: `${origin}/` },
      });
      if (!Array.isArray(data) || data.length === 0) {
        ctx.log(`panynj ${code}: empty or malformed response, skipping`);
        failures++;
        continue;
      }
      readings.push(buildReading(code, data));
    } catch (err) {
      ctx.log(`panynj ${code}: ${err?.message ?? err}`);
      failures++;
    }
  }

  if (failures === codes.length) {
    throw new Error(`panynj: all ${codes.length} airport feeds failed`);
  }
  return readings;
}
