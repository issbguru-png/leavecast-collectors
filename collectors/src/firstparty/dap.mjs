// DAP-platform airports (dap.aero vendor): MCO (GOAA), DFW, IAH (Houston).
// All three share one request shape: GET {base}/wait-times/checkpoint/{code}
// with an API key in the `x-api-key` header. Keys are NOT public — each must be
// obtained via the airport authority's data/developer program and set in env:
//   DAP_MCO_KEY, DAP_DFW_KEY, DAP_IAH_KEY
// An airport with no key set is skipped silently (stays on the reseller feed).
// This collector activates per-airport as keys arrive — no code change needed.
import { nowIso } from '../../lib/contract.mjs';

const AIRPORTS = [
  { iata: 'MCO', base: 'https://api.goaa.aero',              envKey: 'DAP_MCO_KEY' },
  { iata: 'DFW', base: 'https://api.dfwairport.mobi',        envKey: 'DAP_DFW_KEY' },
  { iata: 'IAH', base: 'https://api.houstonairports.mobi',   envKey: 'DAP_IAH_KEY' },
];

function toMin(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) ? Math.round(n / 60) : null;
}

/** Normalize one DAP checkpoint record → { name, waitMin, lane, isOpen }. */
function normCheckpoint(cp) {
  const waitMin = cp.waitSeconds != null ? toMin(cp.waitSeconds)
    : cp.waitMinutes != null ? Math.round(Number(cp.waitMinutes)) : null;
  return {
    name: cp.name ?? cp.checkpoint ?? cp.poi_id ?? 'Checkpoint',
    lane: (cp.lane ?? cp.type ?? '').toString(),
    waitMin,
    isOpen: cp.isOpen !== false,
  };
}

export async function collect(ctx) {
  const out = [];
  for (const a of AIRPORTS) {
    const key = ctx.env[a.envKey];
    if (!key) continue; // no key yet → reseller handles this airport
    try {
      const res = await fetch(`${a.base}/wait-times/checkpoint/${a.iata}`, {
        signal: AbortSignal.timeout(20000),
        headers: { 'x-api-key': key, accept: 'application/json' },
      });
      if (!res.ok) { ctx.log(`${a.iata} DAP HTTP ${res.status}`); continue; }
      const json = await res.json();
      const list = json?.data?.wait_times ?? json?.data?.checkpoints ?? [];
      if (!Array.isArray(list) || list.length === 0) { ctx.log(`${a.iata} DAP: no checkpoints`); continue; }
      const cps = list.map(normCheckpoint);
      const std = cps.filter((c) => c.isOpen && !/pre[-\s]?check|tsapre/i.test(c.lane) && c.waitMin != null);
      const pre = cps.filter((c) => /pre[-\s]?check|tsapre/i.test(c.lane));
      out.push({
        source: 'firstparty',
        airport: a.iata,
        kind: 'security_wait',
        observedAt: nowIso(),
        payload: {
          standardMin: std.length ? Math.max(...std.map((c) => c.waitMin)) : null,
          precheckOpen: pre.length ? pre.some((c) => c.isOpen) : null,
          checkpoints: cps.filter((c) => c.waitMin != null)
            .map((c) => ({ name: c.name, waitMin: c.waitMin, status: c.isOpen ? 'Open' : 'Closed' })),
        },
      });
    } catch (err) {
      ctx.log(`${a.iata} DAP failed: ${err?.message ?? err}`);
    }
  }
  return out;
}
