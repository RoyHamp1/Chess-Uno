import './env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sqlPath = path.join(__dirname, 'schema.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const pool = getPool();
await pool.query(sql);
console.log('Applied schema from', sqlPath);
await pool.end();
process.exit(0);
