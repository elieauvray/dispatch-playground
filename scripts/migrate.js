'use strict';

const fs = require('fs');
const path = require('path');

const db = require('../src/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function run() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migrations found.');
    return;
  }

  const pool = db.getPool();
  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Applying migration ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    console.log('Migrations applied.');
  } finally {
    client.release();
  }
}

run()
  .then(() => db.close())
  .catch(async (err) => {
    console.error(err.message);
    await db.close().catch(() => {});
    process.exitCode = 1;
  });
