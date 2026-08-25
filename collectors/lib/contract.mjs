// ============================================================================
// GateWaitTimes collector contract — THE interface every collector implements.
// Written before fan-out; do not change shapes without updating all collectors,
// docs/schema.sql, and the writers below.
// ============================================================================

/**
 * @typedef {Object} Reading
 * @property {'tsawaittimes'|'faa'|'nws'|'cbp'|'firstparty'} source
 * @property {string}  airport     IATA code, uppercase ('ORD'). For FAA system-
 *                                 wide rows use the affected airport's IATA.
 * @property {'security_wait'|'faa_status'|'weather'|'customs_wait'} kind
 * @property {string}  observedAt  ISO8601 UTC — when the value was observed
 *                                 (upstream timestamp if given, else fetch time)
 * @property {Object}  payload     Normalized per-kind fields (see docs/schema.sql):
 *   security_wait: { standardMin:number|null, precheckOpen:boolean|null,
 *                    checkpoints?:Array<{name:string, waitMin:number|null, status?:string}> }
 *   faa_status:    { closure:boolean, groundStop:boolean, groundDelay:boolean,
 *                    generalDelay:boolean, reason:string|null, avgDelay:string|null }
 *   weather:       { tempF:number|null, windMph:number|null, shortForecast:string|null,
 *                    impact:'none'|'light'|'moderate'|'severe' }
 *   customs_wait:  { usMaxMin:number|null, usAvgMin:number|null,
 *                    nonUsMaxMin:number|null, nonUsAvgMin:number|null, boothsOpen:number|null }
 */

/** Each collector module exports: async collect(ctx) -> Reading[]
 *  ctx = { registry, env, fetchJson, fetchText, log }
 *  Collectors NEVER write; the runner owns the writer. Collectors NEVER throw
 *  for a single bad airport — skip it, log it, return the rest. Throw only if
 *  the whole feed is down. */

const UA = 'GateWaitTimes/0.1 (data collector; contact: ops@gatewaittimes.com)';

export async function fetchText(url, { timeoutMs = 20000, headers = {} } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export function nowIso() { return new Date().toISOString(); }

/** Validate a Reading; returns error string or null. Runner drops invalid rows loudly. */
export function validateReading(r) {
  const KINDS = ['security_wait', 'faa_status', 'weather', 'customs_wait'];
  const SOURCES = ['tsawaittimes', 'faa', 'nws', 'cbp', 'firstparty'];
  if (!SOURCES.includes(r?.source)) return `bad source: ${r?.source}`;
  if (!/^[A-Z]{3}$/.test(r?.airport ?? '')) return `bad airport: ${r?.airport}`;
  if (!KINDS.includes(r?.kind)) return `bad kind: ${r?.kind}`;
  if (Number.isNaN(Date.parse(r?.observedAt ?? ''))) return `bad observedAt: ${r?.observedAt}`;
  if (typeof r?.payload !== 'object' || r.payload === null) return 'payload not an object';
  return null;
}
