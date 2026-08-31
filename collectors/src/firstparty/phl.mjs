// ============================================================================
// PHL first-party security-wait collector — Philadelphia International (PHL).
// Platform: LiveReach. Feed: https://www.phl.org/phllivereach/metrics (JSON).
// Emits ONE 'security_wait' reading (source 'firstparty', airport 'PHL').
//
// The feed is columnar: { result, content: { columns:[{name,...}], rows:[[...]] } }.
// Observed columns: "Zone ID" (integer), "waitTime" (float minutes),
// "waitTimeRange" ({ lower_bound, upper_bound }). Rows are checkpoint queue zones.
//
// Zones are identified by numeric ID only — the feed carries NO friendly names
// or timestamp. We map column names -> indices from the `columns` array (never
// assume position). Zone IDs get a safe "Checkpoint {id}" label; friendly names
// can be refined later if PHL exposes a zone-name map. Zero deps, Node 20+ ESM.
// ============================================================================

import { nowIso } from '../../lib/contract.mjs';

const FEED_URL = 'https://www.phl.org/phllivereach/metrics';

// Browser-ish UA — the LiveReach endpoint rejects some default agents.
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

// Zone ID -> friendly checkpoint name. Empty for now: the feed exposes no names,
// so we fall back to `Checkpoint ${id}`. Populate here once names are verified.
const ZONE_NAMES = Object.create(null);

function round(n) {
  return n == null || Number.isNaN(n) ? null : Math.round(n);
}

/** Build { name -> columnIndex } from the columns array; null if not columnar. */
function indexColumns(columns) {
  if (!Array.isArray(columns)) return null;
  const idx = Object.create(null);
  columns.forEach((c, i) => {
    if (c && typeof c.name === 'string') idx[c.name] = i;
  });
  return idx;
}

export async function collect(ctx) {
  const observedAt = nowIso();
  const body = await ctx.fetchJson(FEED_URL, { headers: HEADERS });

  const content = body?.content ?? body;
  const cols = indexColumns(content?.columns);
  const rows = content?.rows;

  if (!cols || !Array.isArray(rows)) {
    throw new Error(`PHL feed malformed: missing columns/rows (${FEED_URL})`);
  }

  const iZone = cols['Zone ID'];
  const iWait = cols['waitTime'];
  const iRange = cols['waitTimeRange'];
  if (iZone === undefined || (iWait === undefined && iRange === undefined)) {
    throw new Error('PHL feed malformed: expected Zone ID + waitTime columns');
  }

  const checkpoints = [];
  let standardMin = null;

  for (const row of rows) {
    if (!Array.isArray(row)) {
      ctx.log(`PHL: skipping non-array row: ${JSON.stringify(row)}`);
      continue;
    }
    const zoneId = row[iZone];
    if (zoneId == null) {
      ctx.log(`PHL: skipping row with no Zone ID: ${JSON.stringify(row)}`);
      continue;
    }

    // Conservative figure: prefer waitTimeRange.upper_bound, else raw waitTime.
    const range = iRange === undefined ? null : row[iRange];
    const upper =
      range && typeof range === 'object' && typeof range.upper_bound === 'number'
        ? range.upper_bound
        : null;
    const raw = iWait === undefined ? null : row[iWait];
    const value = upper != null ? upper : typeof raw === 'number' ? raw : null;

    if (value == null || Number.isNaN(value)) {
      ctx.log(`PHL: skipping zone ${zoneId} with no numeric wait`);
      continue;
    }

    const waitMin = round(value);
    if (standardMin === null || waitMin > standardMin) standardMin = waitMin;

    checkpoints.push({
      name: ZONE_NAMES[zoneId] || `Checkpoint ${zoneId}`,
      waitMin,
      status: 'Open',
    });
  }

  if (!checkpoints.length) ctx.log('PHL: no zones with usable wait data');

  return [{
    source: 'firstparty',
    airport: 'PHL',
    kind: 'security_wait',
    observedAt,
    payload: {
      standardMin,
      // PHL's LiveReach feed does not flag PreCheck zones — leave null, don't guess.
      precheckOpen: null,
      precheckMin: null,
      checkpoints,
    },
  }];
}
