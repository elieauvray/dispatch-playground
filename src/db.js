'use strict';

const { Pool } = require('pg');

/**
 * Build a pg connection config.
 *
 * Locally (and in CI) a DATABASE_URL is used directly. On Upsun the
 * credentials are exposed through the base64-encoded PLATFORM_RELATIONSHIPS
 * environment variable, which we decode and read the `database` relationship
 * from.
 */
function buildConfig(env = process.env) {
  if (env.DATABASE_URL) {
    return { connectionString: env.DATABASE_URL };
  }

  if (env.PLATFORM_RELATIONSHIPS) {
    let relationships;
    try {
      relationships = JSON.parse(
        Buffer.from(env.PLATFORM_RELATIONSHIPS, 'base64').toString('utf8')
      );
    } catch (err) {
      throw new Error(`Unable to parse PLATFORM_RELATIONSHIPS: ${err.message}`);
    }

    const instances = relationships.database;
    if (!Array.isArray(instances) || instances.length === 0) {
      throw new Error(
        `No "database" relationship found. Available relationships: ${Object.keys(
          relationships
        ).join(', ') || '(none)'}`
      );
    }

    const creds = instances[0];
    return {
      host: creds.host,
      port: creds.port,
      database: creds.path,
      user: creds.username,
      password: creds.password
    };
  }

  throw new Error(
    'No database configuration found: set DATABASE_URL (local) or run with a "database" relationship (Upsun).'
  );
}

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool(buildConfig());
    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function close() {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}

module.exports = { buildConfig, getPool, query, close };
