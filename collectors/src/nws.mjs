// NWS collector — current-hour forecast per airport gridpoint.
// https://api.weather.gov/gridpoints/{office}/{gridX},{gridY}/forecast/hourly
// Airports with nwsGrid null (not yet enriched) or false (outside coverage,
// e.g. Guam) are skipped silently; run tools/enrich-nws-grids.mjs to fill grids.

const CONCURRENCY = 8;

function parseWindMph(windSpeed) {
  const nums = String(windSpeed ?? '').match(/\d+/g);
  return nums ? Number(nums[nums.length - 1]) : null;
}

function deriveImpact(shortForecast, windMph) {
  const sf = shortForecast ?? '';
  const wind = windMph ?? 0;
  if (/thunder|snow|ice|freezing|blizzard/i.test(sf) || wind >= 40) return 'severe';
  if (/rain|storm/i.test(sf) || wind >= 25) return 'moderate';
  if (/shower|drizzle|fog/i.test(sf) || wind >= 15) return 'light';
  return 'none';
}

/** @returns {Promise<import('../lib/contract.mjs').Reading[]>} */
export async function collect(ctx) {
  const targets = ctx.registry.filter((a) => a.nwsGrid);
  const readings = [];

  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const a = targets[next++];
      const { office, gridX, gridY } = a.nwsGrid;
      try {
        const json = await ctx.fetchJson(
          `https://api.weather.gov/gridpoints/${office}/${gridX},${gridY}/forecast/hourly`,
        );
        const period = json?.properties?.periods?.[0];
        if (!period) throw new Error('no forecast periods');
        const windMph = parseWindMph(period.windSpeed);
        const tempF = typeof period.temperature === 'number' ? period.temperature : null;
        const shortForecast = period.shortForecast ?? null;
        readings.push({
          source: 'nws',
          airport: a.iata,
          kind: 'weather',
          observedAt: new Date(period.startTime).toISOString(),
          payload: { tempF, windMph, shortForecast, impact: deriveImpact(shortForecast, windMph) },
        });
      } catch (err) {
        ctx.log(`skip ${a.iata}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return readings;
}
