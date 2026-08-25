#!/usr/bin/env node
// node --env-file=.env collectors/tools/apply-schema.mjs [schema-file]
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const file = process.argv[2] ?? 'docs/schema-neon.sql';
const sql = await readFile(file, 'utf8');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
await pool.query(sql);
const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
console.error('[schema] tables:', t.rows.map(r => r.table_name).join(', '));
await pool.end();
