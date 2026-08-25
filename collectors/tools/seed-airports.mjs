#!/usr/bin/env node
// node --env-file=.env collectors/tools/seed-airports.mjs
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const reg = JSON.parse(await readFile('data/registry/airports.json', 'utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
await pool.query(`
  INSERT INTO airports (iata, icao, name, city, state, lat, lon, size, nws_office, nws_grid_x, nws_grid_y)
  SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],
                       $6::float8[],$7::float8[],$8::text[],$9::text[],$10::int[],$11::int[])
  ON CONFLICT (iata) DO UPDATE SET
    name=EXCLUDED.name, city=EXCLUDED.city, state=EXCLUDED.state,
    lat=EXCLUDED.lat, lon=EXCLUDED.lon, size=EXCLUDED.size,
    nws_office=EXCLUDED.nws_office, nws_grid_x=EXCLUDED.nws_grid_x, nws_grid_y=EXCLUDED.nws_grid_y`,
  [reg.map(a=>a.iata), reg.map(a=>a.icao), reg.map(a=>a.name), reg.map(a=>a.city),
   reg.map(a=>a.state), reg.map(a=>a.lat), reg.map(a=>a.lon), reg.map(a=>a.size),
   reg.map(a=>a.nwsGrid?.office ?? null), reg.map(a=>a.nwsGrid?.gridX ?? null), reg.map(a=>a.nwsGrid?.gridY ?? null)]);
const { rows } = await pool.query('SELECT count(*) FROM airports');
console.error('[seed] airports in DB:', rows[0].count);
await pool.end();
