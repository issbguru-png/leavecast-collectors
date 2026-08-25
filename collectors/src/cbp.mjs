// CBP Airport Wait Times collector — customs/immigration waits per airport terminal.
// https://awt.cbp.gov is a SPA over a small JSON API:
//   GET  https://awt.cbp.gov/api/waitTime
//        -> { Airports: [{ IATA, Id, IsPublic, Name, Terminal, LastUpdated }],
//             FlightDateRange: { MinFlightDate, MaxFlightDate } }   (Id = site, one per airport+terminal)
//   POST https://awt.cbp.gov/api/waitTime  body { Id, FromDate, ToDate }
//        -> { Items: [hourly rows], AirportName, FromDate, ToDate, UniqueTerminals, Id }
// Each Item: { AirportCode, TerminalName, FlightDate: 'YYYY-MM-DD', HourRange: '0500 - 0600',
//   UsaPassengerMaxWait, UsaPassengerAverageWait, NonUsaPassengerMaxWait,
//   NonUsaPassengerAverageWait, BoothsUsed, LastUpdated, MaxWait, AverageWait, ... }
// Data is published with a ~2 day lag (FlightDateRange.MaxFlightDate); we fetch the most
// recent published day and emit one Reading per airport+terminal using its latest hour row.
// HourRange is the airport's local hour but carries no zone; we stamp it as UTC — the best
// available upstream timestamp (falling back to the row's LastUpdated, then fetch time).

import { nowIso } from '../lib/contract.mjs';

const BASE = 'https://awt.cbp.gov/api/waitTime';
const UA = 'GateWaitTimes/0.1 (data collector; contact: ops@gatewaittimes.com)';
const CONCURRENCY = 6;

/** ctx.fetchJson is GET-only, so the report query needs its own POST helper. */
async function postJson(url, body, { timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} POST ${url}`);
  return res.json();
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** '0500 - 0600' -> end-of-window hour (6), or null if unparseable. */
function hourRangeEnd(hourRange) {
  const m = /^\s*\d{3,4}\s*-\s*(\d{1,2})\d{2}\s*$/.exec(hourRange ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 24 ? h : null;
}

/** Best upstream timestamp for a row: FlightDate + HourRange end, else LastUpdated, else fetch time. */
function rowObservedAt(row) {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(row?.FlightDate ?? '');
  const endHour = hourRangeEnd(row?.HourRange);
  if (d && endHour !== null) {
    return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), endHour)).toISOString();
  }
  const lu = Date.parse(row?.LastUpdated ? `${row.LastUpdated}Z` : '');
  if (!Number.isNaN(lu)) return new Date(lu).toISOString();
  return nowIso();
}

/** Sort key so the latest hour row wins within a terminal. */
function rowSortKey(row) {
  return `${row?.FlightDate ?? ''} ${String(hourRangeEnd(row?.HourRange) ?? 0).padStart(2, '0')}`;
}

/** One Reading from the latest hourly row of an airport+terminal. */
function reading(iata, row) {
  return {
    source: 'cbp',
    airport: iata,
    kind: 'customs_wait',
    observedAt: rowObservedAt(row),
    payload: {
      usMaxMin: num(row.UsaPassengerMaxWait),
      usAvgMin: num(row.UsaPassengerAverageWait),
      nonUsMaxMin: num(row.NonUsaPassengerMaxWait),
      nonUsAvgMin: num(row.NonUsaPassengerAverageWait),
      boothsOpen: num(row.BoothsUsed),
      terminal: String(row.TerminalName ?? '').trim() || 'Unknown',
    },
  };
}

export async function collect(ctx) {
  const { registry, fetchJson, log } = ctx;
  const known = new Set(registry.map((a) => a.iata));

  // Whole-feed failure here should throw: nothing works without the viewmodel.
  const vm = await fetchJson(BASE);
  const day = vm?.FlightDateRange?.MaxFlightDate;
  if (!day || !Array.isArray(vm?.Airports)) throw new Error('cbp: malformed viewmodel from /api/waitTime');

  const sites = vm.Airports.filter((s) => s?.IsPublic !== false && s?.Id);
  const skipped = [...new Set(sites.filter((s) => !known.has(s.IATA)).map((s) => s.IATA))];
  if (skipped.length > 0) log(`skipping airports not in registry: ${skipped.join(', ')}`);
  const wanted = sites.filter((s) => known.has(s.IATA));
  log(`querying ${wanted.length} airport+terminal sites for ${day} (latest published day)`);

  const readings = [];
  let cursor = 0;
  async function worker() {
    while (cursor < wanted.length) {
      const site = wanted[cursor++];
      try {
        const report = await postJson(BASE, { Id: site.Id, FromDate: day, ToDate: day });
        const items = Array.isArray(report?.Items) ? report.Items : [];
        // A site normally covers one terminal, but group defensively and take
        // each terminal's latest hour row.
        const latestByTerminal = new Map();
        for (const row of items) {
          const key = String(row?.TerminalName ?? site.Terminal ?? '');
          const prev = latestByTerminal.get(key);
          if (!prev || rowSortKey(row) > rowSortKey(prev)) latestByTerminal.set(key, row);
        }
        if (latestByTerminal.size === 0) {
          log(`no rows for ${site.IATA} ${site.Terminal ?? ''} (${site.Id}) on ${day}`);
          continue;
        }
        for (const row of latestByTerminal.values()) readings.push(reading(site.IATA, row));
      } catch (e) {
        log(`skip ${site.IATA} ${site.Terminal ?? ''} (${site.Id}): ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));

  if (readings.length === 0) throw new Error('cbp: feed returned no usable rows');
  return readings;
}
