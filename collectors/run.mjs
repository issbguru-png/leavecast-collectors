#!/usr/bin/env node
// Runner: node collectors/run.mjs <tsa|faa|nws|cbp> [--limit N]
// Owns registry loading, writer selection, validation, and exit codes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReading, fetchJson, fetchText } from './lib/contract.mjs';
import { ndjsonWriter, pgWriter } from './lib/writers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULES = { tsa: './src/tsa.mjs', faa: './src/faa.mjs', nws: './src/nws.mjs', cbp: './src/cbp.mjs', firstparty: './src/firstparty/index.mjs' };

const name = process.argv[2];
if (!MODULES[name]) { console.error(`usage: run.mjs <${Object.keys(MODULES).join('|')}>`); process.exit(2); }
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const registryAll = JSON.parse(await readFile(path.join(ROOT, 'data/registry/airports.json'), 'utf8'));
const registry = registryAll.slice(0, limit);
const log = (...a) => console.error(`[${name}]`, ...a);

const { collect } = await import(MODULES[name]);
const t0 = Date.now();
const rows = await collect({ registry, env: process.env, fetchJson, fetchText, log });

const good = [];
for (const r of rows) {
  const err = validateReading(r);
  if (err) log('DROP invalid reading:', err);
  else good.push(r);
}

const writer = process.env.DATABASE_URL
  ? await pgWriter(process.env.DATABASE_URL)
  : ndjsonWriter(path.join(ROOT, 'data/out'));
await writer.write(good);
if (writer.end) await writer.end();

log(`${good.length} readings (${rows.length - good.length} dropped) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (good.length === 0) process.exit(1);
