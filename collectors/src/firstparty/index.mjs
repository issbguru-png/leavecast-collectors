// Aggregator for all first-party airport feeds. Static imports (not dynamic)
// so bundlers trace every sub-collector into serverless deployments. Each runs
// independently; one feed failing never blocks the others or the reseller
// baseline that already covers these airports.
import * as panynj from './panynj.mjs';
import * as mwaa from './mwaa.mjs';
import * as dtw from './dtw.mjs';
import * as phx from './phx.mjs';
import * as phl from './phl.mjs';
import * as dap from './dap.mjs';  // MCO/DFW/IAH — activates per-airport as keys arrive

const FEEDS = [
  ['panynj', panynj],  // JFK, LGA, EWR
  ['mwaa', mwaa],      // DCA, IAD
  ['dtw', dtw],        // Detroit
  ['phx', phx],        // Phoenix Sky Harbor
  ['phl', phl],        // Philadelphia
  ['dap', dap],        // MCO, DFW, IAH (key-gated; no-op until DAP_*_KEY set)
];

export async function collect(ctx) {
  const settled = await Promise.allSettled(
    FEEDS.map(async ([name, mod]) => {
      try {
        const rows = await mod.collect(ctx);
        return Array.isArray(rows) ? rows : [];
      } catch (err) {
        ctx.log(`feed ${name} failed: ${err?.message ?? err}`);
        return [];
      }
    })
  );
  const rows = [];
  for (const s of settled) if (s.status === 'fulfilled') rows.push(...s.value);
  ctx.log(`first-party: ${rows.length} readings from ${FEEDS.length} feeds`);
  return rows;
}
