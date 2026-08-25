// ============================================================================
// FAA collector — National Airspace System airport status.
// Feed: https://nasstatus.faa.gov/api/airport-status-information (XML).
// Emits one 'faa_status' reading per registry airport; airports absent from
// the feed get all-false flags. Zero deps — the XML is flat enough for regex.
// ============================================================================

import { nowIso } from '../lib/contract.mjs';

const FEED_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse the feed's Update_Time ('Tue Aug 25 11:11:09 2026 GMT') to ISO8601 UTC. */
function parseUpdateTime(text) {
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$/.exec(text?.trim() ?? '');
  if (m && MONTHS[m[1]] !== undefined) {
    return new Date(Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))).toISOString();
  }
  const t = Date.parse(text ?? '');
  return Number.isNaN(t) ? nowIso() : new Date(t).toISOString();
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** First <tag>…</tag> inner text within xml, entity-decoded and trimmed; null if absent. */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeEntities(m[1]).trim() : null;
}

/** All <tag>…</tag> inner chunks within xml (raw, for nested parsing). */
function tagChunks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  for (let m; (m = re.exec(xml)); ) out.push(m[1]);
  return out;
}

function emptyStatus() {
  return { closure: false, groundStop: false, groundDelay: false, generalDelay: false, reason: null, avgDelay: null };
}

function addReason(status, reason) {
  if (!reason) return;
  status.reason = status.reason ? `${status.reason}; ${reason}` : reason;
}

/** Parse the feed into a map of IATA -> faa_status payload. */
function parseFeed(xml) {
  const byAirport = new Map();
  const get = (arpt) => {
    const iata = arpt.toUpperCase();
    if (!byAirport.has(iata)) byAirport.set(iata, emptyStatus());
    return byAirport.get(iata);
  };

  // <Ground_Stop_List><Program><ARPT>DFW</ARPT><Reason>…</Reason><End_Time>…</End_Time></Program>…
  for (const list of tagChunks(xml, 'Ground_Stop_List')) {
    for (const prog of tagChunks(list, 'Program')) {
      const arpt = tagText(prog, 'ARPT');
      if (!arpt) continue;
      const status = get(arpt);
      status.groundStop = true;
      const end = tagText(prog, 'End_Time');
      addReason(status, [tagText(prog, 'Reason'), end ? `(until ${end})` : null].filter(Boolean).join(' ') || null);
    }
  }

  // <Ground_Delay_List><Ground_Delay><ARPT>SFO</ARPT><Reason>…</Reason><Avg>…</Avg><Max>…</Max></Ground_Delay>…
  for (const list of tagChunks(xml, 'Ground_Delay_List')) {
    for (const gd of tagChunks(list, 'Ground_Delay')) {
      const arpt = tagText(gd, 'ARPT');
      if (!arpt) continue;
      const status = get(arpt);
      status.groundDelay = true;
      addReason(status, tagText(gd, 'Reason'));
      const avg = tagText(gd, 'Avg');
      if (avg && !status.avgDelay) status.avgDelay = avg;
    }
  }

  // <Arrival_Departure_Delay_List><Delay><ARPT>ORD</ARPT><Reason>…</Reason>
  //   <Arrival_Departure Type="Departure"><Min>…</Min><Max>…</Max><Trend>…</Trend></Arrival_Departure></Delay>…
  for (const list of tagChunks(xml, 'Arrival_Departure_Delay_List')) {
    for (const delay of tagChunks(list, 'Delay')) {
      const arpt = tagText(delay, 'ARPT');
      if (!arpt) continue;
      const status = get(arpt);
      status.generalDelay = true;
      addReason(status, tagText(delay, 'Reason'));
      const re = /<Arrival_Departure[^>]*Type="([^"]*)"[^>]*>([\s\S]*?)<\/Arrival_Departure>/g;
      for (let m; (m = re.exec(delay)); ) {
        const min = tagText(m[2], 'Min');
        const max = tagText(m[2], 'Max');
        const range = min && max && min !== max ? `${min} to ${max}` : (max ?? min);
        if (!range) continue;
        const text = `${m[1]} ${range}`;
        status.avgDelay = status.avgDelay ? `${status.avgDelay}; ${text}` : text;
      }
    }
  }

  // <Airport_Closure_List><Airport><ARPT>XXX</ARPT><Reason>…</Reason><Start>…</Start><Reopen>…</Reopen></Airport>…
  for (const list of tagChunks(xml, 'Airport_Closure_List')) {
    for (const ap of tagChunks(list, 'Airport')) {
      const arpt = tagText(ap, 'ARPT');
      if (!arpt) continue;
      const status = get(arpt);
      status.closure = true;
      const reopen = tagText(ap, 'Reopen');
      addReason(status, [tagText(ap, 'Reason'), reopen ? `(reopen ${reopen})` : null].filter(Boolean).join(' ') || null);
    }
  }

  return byAirport;
}

export async function collect(ctx) {
  const xml = await ctx.fetchText(FEED_URL);
  const observedAt = parseUpdateTime(tagText(xml, 'Update_Time'));
  const byAirport = parseFeed(xml);

  const flagged = [...byAirport.keys()];
  if (flagged.length) ctx.log(`feed flags: ${flagged.join(', ')}`);

  return ctx.registry.map((a) => ({
    source: 'faa',
    airport: a.iata,
    kind: 'faa_status',
    observedAt,
    payload: byAirport.get(a.iata) ?? emptyStatus(),
  }));
}
