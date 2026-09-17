const express = require('express');
const { Pool } = require('pg');

const seedRows = [
  ['National Cheese Registry', 'healthy', 'All cheese filings are flowing successfully.'],
  ['Emergency Biscuit Support', 'healthy', 'Biscuit uptake remains within policy boundaries.'],
  ['Public Confidence Monitoring', 'healthy', 'National morale is stable and monitored continuously.']
];

function createPool(databaseUrl) {
  if (!databaseUrl) return null;

  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ssl: databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : false
  });
}

function createApp(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? '';
  const pool = options.pool ?? createPool(databaseUrl);
  const app = express();
  let initialization;

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(JSON.stringify({
        severity: 'info',
        service: 'backend',
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      }));
    });
    next();
  });

  async function initializeDatabase() {
    if (!pool) return;
    if (!initialization) {
      initialization = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS public.service_status (
            id SERIAL PRIMARY KEY,
            service_name TEXT NOT NULL,
            status TEXT NOT NULL,
            summary TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        const existing = await pool.query('SELECT COUNT(*) AS row_count FROM public.service_status');
        if (Number(existing.rows[0].row_count) === 0) {
          for (const row of seedRows) {
            await pool.query(
              'INSERT INTO public.service_status (service_name, status, summary) VALUES ($1, $2, $3)',
              row
            );
          }
        }
      })().catch((error) => {
        initialization = undefined;
        throw error;
      });
    }
    await initialization;
  }

  app.get(['/health', '/health/live'], (req, res) => {
    res.json({ status: 'ok', service: 'backend' });
  });

  app.get('/health/ready', async (req, res) => {
    if (!pool) {
      return res.status(503).json({ status: 'not-ready', service: 'backend', dependency: 'postgres' });
    }

    try {
      await pool.query('SELECT 1');
      return res.json({ status: 'ready', service: 'backend', dependency: 'postgres' });
    } catch (error) {
      console.error(JSON.stringify({ severity: 'error', service: 'backend', event: 'postgres-readiness-failed', message: error.message }));
      return res.status(503).json({ status: 'not-ready', service: 'backend', dependency: 'postgres' });
    }
  });

  app.get('/api/status', async (req, res) => {
    if (!pool) {
      return res.json({
        service: 'National Cheese Registry',
        status: 'healthy',
        summary: 'Mock mode is active for local development.',
        updatedAt: new Date().toISOString(),
        source: 'mock'
      });
    }

    try {
      await initializeDatabase();
      const result = await pool.query(`
        SELECT service_name, status, summary, updated_at
        FROM public.service_status
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `);
      const latest = result.rows[0];

      return res.json({
        service: latest.service_name,
        status: latest.status,
        summary: latest.summary,
        updatedAt: latest.updated_at,
        source: 'database'
      });
    } catch (error) {
      console.error(JSON.stringify({ severity: 'error', service: 'backend', event: 'postgres-query-failed', message: error.message }));
      return res.status(503).json({
        service: 'National Cheese Registry',
        status: 'error',
        summary: 'PostgreSQL is unavailable. This is an excellent time for calm, logs and an SRE agent.',
        updatedAt: new Date().toISOString(),
        source: 'database-error'
      });
    }
  });

  app.locals.close = async () => {
    if (pool) await pool.end();
  };

  return app;
}

module.exports = { createApp };
