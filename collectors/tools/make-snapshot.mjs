#!/usr/bin/env node
// Distill data/out NDJSON into data/snapshot/latest.json — the latest reading
// per airport per kind. Committed to git so serverless deploys always have
// data to render even before the DB exists. Refresh + commit on each deploy.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(ROOT, 'data/out');
const map = new Map();
let days = [];
try { days = (await readdir(outDir)).sort().slice(-2); } catch { }
for (const day of days) {
  for (const file of await readdir(path.join(outDir, day))) {
    const text = await readFile(path.join(outDir, day, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        const k = `${r.airport}:${r.kind}`;
        const prev = map.get(k);
        if (!prev || prev.observedAt < r.observedAt) map.set(k, r);
      } catch { }
    }
  }
}
await mkdir(path.join(ROOT, 'data/snapshot'), { recursive: true });
const obj = Object.fromEntries([...map.entries()].sort());
await writeFile(path.join(ROOT, 'data/snapshot/latest.json'), JSON.stringify(obj));
console.error(`[snapshot] ${map.size} latest readings written to data/snapshot/latest.json`);
