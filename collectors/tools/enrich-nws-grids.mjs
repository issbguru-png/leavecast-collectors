#!/usr/bin/env node
// One-time enrichment: fill nwsGrid ({office, gridX, gridY}) in
// data/registry/airports.json via https://api.weather.gov/points/{lat},{lon}.
// Usage: node collectors/tools/enrich-nws-grids.mjs [--limit N]
//
// Airports outside NWS grid coverage (Guam, some territories) get nwsGrid:false
// so we never retry them; transient failures stay null for a later re-run.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from '../lib/contract.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const REGISTRY_PATH = path.join(ROOT, 'data/registry/airports.json');

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[enrich-nws-grids]', ...a);

const airports = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
const todo = airports.filter((a) => a.nwsGrid === null).slice(0, limit);
log(`${airports.length} airports in registry, ${todo.length} to enrich`);

let ok = 0, outside = 0, failed = 0;
for (const a of todo) {
  const url = `https://api.weather.gov/points/${a.lat},${a.lon}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1000); // brief pause before the single retry
    try {
      const json = await fetchJson(url);
      const { gridId, gridX, gridY } = json?.properties ?? {};
      if (!gridId || gridX == null || gridY == null) throw new Error('missing grid fields');
      a.nwsGrid = { office: gridId, gridX, gridY };
      log(`${a.iata} -> ${gridId} ${gridX},${gridY}`);
      ok++;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (/HTTP 404/.test(err.message)) break; // outside coverage; no point retrying
    }
  }
  if (lastErr) {
    if (/HTTP 404/.test(lastErr.message)) {
      a.nwsGrid = false; // outside NWS grid coverage — never retry
      log(`${a.iata} outside NWS coverage (404), nwsGrid=false`);
      outside++;
    } else {
      log(`${a.iata} FAILED (left null for re-run): ${lastErr.message}`);
      failed++;
    }
  }
  await sleep(500); // ~2 requests/sec
}

await writeFile(REGISTRY_PATH, JSON.stringify(airports, null, 1) + '\n');
log(`done: ${ok} enriched, ${outside} outside coverage, ${failed} failed; registry rewritten`);
