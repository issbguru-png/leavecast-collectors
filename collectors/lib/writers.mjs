import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

/** NDJSON writer — local dev + backfill-safe archive. One file per source per UTC day. */
export function ndjsonWriter(rootDir) {
  return {
    async write(rows) {
      if (!rows.length) return;
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(rootDir, day);
      await mkdir(dir, { recursive: true });
      const bySource = Object.groupBy(rows, (r) => r.source);
      for (const [source, group] of Object.entries(bySource)) {
        const lines = group.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await appendFile(path.join(dir, `${source}.ndjson`), lines);
      }
    },
  };
}

/** Postgres writer — used when DATABASE_URL is set. Requires `pg` (prod only;
 *  keep collectors themselves zero-dependency). */
export async function pgWriter(databaseUrl) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  return {
    async write(rows) {
      if (!rows.length) return;
      const text = `INSERT INTO readings (ts, airport, source, kind, payload)
                    SELECT * FROM unnest($1::timestamptz[],$2::text[],$3::text[],$4::text[],$5::jsonb[])`;
      await pool.query(text, [
        rows.map((r) => r.observedAt),
        rows.map((r) => r.airport),
        rows.map((r) => r.source),
        rows.map((r) => r.kind),
        rows.map((r) => JSON.stringify(r.payload)),
      ]);
      // keep `latest` current (page reads hit only this table)
      await pool.query(`
        INSERT INTO latest (airport, kind, ts, source, payload)
        SELECT DISTINCT ON (a, k, s) a, k, t, s, p FROM unnest(
          $2::text[], $4::text[], $1::timestamptz[], $3::text[], $5::jsonb[]
        ) AS u(a, k, t, s, p) ORDER BY a, k, s, t DESC
        ON CONFLICT (airport, kind, source) DO UPDATE
          SET ts = EXCLUDED.ts, payload = EXCLUDED.payload
          WHERE EXCLUDED.ts >= latest.ts`, [
        rows.map((r) => r.observedAt),
        rows.map((r) => r.airport),
        rows.map((r) => r.source),
        rows.map((r) => r.kind),
        rows.map((r) => JSON.stringify(r.payload)),
      ]);
      // incremental hourly curves (the moat) for security waits
      const sec = rows.filter((r) => r.kind === 'security_wait' && r.payload.standardMin != null && !r.payload.mock);
      if (sec.length) {
        await pool.query(`
          INSERT INTO security_wait_hourly (airport, dow, hour, n, sum_wait, max_wait)
          SELECT a, extract(dow FROM t)::int, extract(hour FROM t)::int, count(*), sum(w), max(w)
          FROM unnest($1::text[], $2::timestamptz[], $3::float8[]) AS u(a, t, w)
          GROUP BY 1, 2, 3
          ON CONFLICT (airport, dow, hour) DO UPDATE SET
            n = security_wait_hourly.n + EXCLUDED.n,
            sum_wait = security_wait_hourly.sum_wait + EXCLUDED.sum_wait,
            max_wait = GREATEST(security_wait_hourly.max_wait, EXCLUDED.max_wait)`, [
          sec.map((r) => r.airport),
          sec.map((r) => r.observedAt),
          sec.map((r) => r.payload.standardMin),
        ]);
      }
    },
    async end() { await pool.end(); },
  };
}
