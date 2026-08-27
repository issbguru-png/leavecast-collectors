// Aggregator for all first-party airport feeds. Runs each sub-collector
// independently; one feed failing (airport site down, schema change, bot wall)
// never blocks the others, and never blocks the reseller baseline that already
// covers these airports. Each sub-collector emits source:'firstparty' Readings.
const COLLECTORS = [
  './panynj.mjs',  // JFK, LGA, EWR (Port Authority)
  './mwaa.mjs',    // DCA, IAD (Metro Washington)
  './dtw.mjs',     // Detroit
  './phx.mjs',     // Phoenix Sky Harbor
  './phl.mjs',     // Philadelphia
];

export async function collect(ctx) {
  const settled = await Promise.allSettled(
    COLLECTORS.map(async (mod) => {
      try {
        const { collect } = await import(mod);
        const rows = await collect(ctx);
        return Array.isArray(rows) ? rows : [];
      } catch (err) {
        ctx.log(`feed ${mod} failed: ${err?.message ?? err}`);
        return [];
      }
    })
  );
  const rows = [];
  for (const s of settled) if (s.status === 'fulfilled') rows.push(...s.value);
  ctx.log(`first-party: ${rows.length} readings from ${COLLECTORS.length} feeds`);
  return rows;
}
