// tsawaittimes.com collector — current security wait per airport.
// https://www.tsawaittimes.com/api/airport/{APIKEY}/{IATA}/json
// Paid API (see docs/tsawaittimes-api.md). Until TSAWAITTIMES_API_KEY is set
// this runs in MOCK mode: synthetic readings for the first 50 registry
// airports so downstream pipelines can be built before the subscription starts.
// Mock rows are marked payload.mock = true. The documented responses carry no
// observation timestamp, so observedAt is fetch time.

import { nowIso } from '../lib/contract.mjs';

const CONCURRENCY = 6;
const MOCK_AIRPORTS = 50;

/** Tolerantly normalize precheck_checkpoints (array or terminal->status map). */
function normalizeCheckpoints(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const entries = Array.isArray(raw)
    ? raw.map((c, i) => [c?.name ?? c?.checkpoint ?? c?.terminal ?? `checkpoint ${i + 1}`, c])
    : Object.entries(raw);
  return entries.map(([name, c]) => {
    const status = typeof c === 'string' ? c : (c?.status ?? c?.state ?? null);
    const wait = typeof c === 'object' && c !== null ? c.waittime ?? c.wait ?? null : null;
    return {
      name: String(name),
      waitMin: typeof wait === 'number' && Number.isFinite(wait) ? wait : null,
      ...(status != null ? { status: String(status) } : {}),
    };
  });
}

function derivePrecheckOpen(json, checkpoints) {
  const open = checkpoints.filter((c) => c.status != null);
  if (open.length > 0) return open.some((c) => /open|true|1/i.test(c.status));
  if ('precheck' in (json ?? {})) return Boolean(Number(json.precheck) || json.precheck === true);
  return null;
}

function apiReading(a, json) {
  const rightnow = Number(json?.rightnow);
  const checkpoints = normalizeCheckpoints(json?.precheck_checkpoints);
  return {
    source: 'tsawaittimes',
    airport: a.iata,
    kind: 'security_wait',
    observedAt: nowIso(), // API responses carry no timestamp
    payload: {
      standardMin: Number.isFinite(rightnow) ? rightnow : null,
      precheckOpen: derivePrecheckOpen(json, checkpoints),
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
    },
  };
}

/** Plausible synthetic wait: morning/evening peaks, per-airport jitter, 5..35. */
function mockReading(a, index) {
  const hour = new Date().getUTCHours();
  const peaks = 10 * Math.exp(-((hour - 12) ** 2) / 18) + 8 * Math.exp(-((hour - 22) ** 2) / 8);
  const jitter = ((index * 7919) % 13) - 6 + Math.random() * 4;
  const standardMin = Math.round(Math.min(35, Math.max(5, 12 + peaks + jitter)));
  return {
    source: 'tsawaittimes',
    airport: a.iata,
    kind: 'security_wait',
    observedAt: nowIso(),
    payload: { standardMin, precheckOpen: Math.random() < 0.8, mock: true },
  };
}

/** @returns {Promise<import('../lib/contract.mjs').Reading[]>} */
export async function collect(ctx) {
  const key = ctx.env.TSAWAITTIMES_API_KEY;
  if (!key) {
    ctx.log('MOCK MODE — no TSAWAITTIMES_API_KEY set');
    return ctx.registry.slice(0, MOCK_AIRPORTS).map((a, i) => mockReading(a, i));
  }

  const targets = ctx.registry;
  const readings = [];

  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const a = targets[next++];
      try {
        const json = await ctx.fetchJson(
          `https://www.tsawaittimes.com/api/airport/${key}/${a.iata}/json`,
        );
        if (!json || typeof json !== 'object' || (!('rightnow' in json) && !('code' in json))) {
          throw new Error('not covered (empty/unrecognized response)');
        }
        readings.push(apiReading(a, json));
      } catch (err) {
        ctx.log(`skip ${a.iata}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return readings;
}
