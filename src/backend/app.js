const express = require('express');
const { Pool } = require('pg');

const serviceStatusRows = [
  ['National Cheese Registry', 'healthy', 'All cheese filings are flowing successfully.'],
  ['Emergency Biscuit Support', 'healthy', 'Biscuit uptake remains within policy boundaries.'],
  ['Public Confidence Monitoring', 'healthy', 'National morale is stable and monitored continuously.']
];

const biscuitRows = [
  ['Custard Cream', 'Cabinet Office', 'COBR snack annex', 'London', 'Sandwich biscuit', 148, 'low', 'Reserved for meetings described as both urgent and cross-government.'],
  ['Chocolate Hobnob', 'Department for Transport', 'Platform 9 refreshment locker', 'Leeds', 'Oat biscuit', 63, 'medium', 'Consumption rises whenever the 08:14 is described as running normally.'],
  ['Rich Tea', 'HM Treasury', 'Fiscal refreshment cupboard', 'London', 'Plain biscuit', 211, 'high', 'Approved because one biscuit can be made to last an entire spending review.'],
  ['Jammy Dodger', 'Home Office', 'Secure preserves cabinet', 'Croydon', 'Jam biscuit', 37, 'medium', 'Red centre must be declared at reception.'],
  ['Bourbon', 'Department for Education', 'Curriculum biscuit archive', 'Sheffield', 'Chocolate biscuit', 92, 'low', 'Included in the national curriculum at key stage tea.'],
  ['Ginger Nut', 'Department of Health and Social Care', 'Resilience tea trolley', 'Leeds', 'Ginger biscuit', 54, 'high', 'Requires a documented dunking risk assessment.'],
  ['Shortbread Finger', 'Foreign, Commonwealth and Development Office', 'Diplomatic biscuit pouch', 'East Kilbride', 'Shortbread', 76, 'low', 'For bilateral tea arrangements and difficult communiques.'],
  ['Malted Milk', 'Department for Environment, Food and Rural Affairs', 'Rural biscuit store', 'York', 'Malted biscuit', 129, 'medium', 'Each biscuit features an animal, subject to seasonal availability.'],
  ['Pink Wafer', 'Department for Science, Innovation and Technology', 'Quantum snack laboratory', 'London', 'Wafer', 18, 'high', 'May exist in both eaten and uneaten states until observed.'],
  ['Digestive', 'Ministry of Justice', 'Courtroom tea evidence store', 'Manchester', 'Wholemeal biscuit', 84, 'low', 'Admissible with tea; coffee requires separate judicial approval.'],
  ['Nice', 'Department for Culture, Media and Sport', 'Ceremonial biscuit collection', 'Manchester', 'Sugar biscuit', 45, 'medium', 'Pronunciation guidance remains under ministerial review.'],
  ['Garibaldi', 'Department for Work and Pensions', 'Operational raisin reserve', 'Newcastle', 'Fruit biscuit', 31, 'high', 'Known internally as the squashed-fly contingency ration.']
];

function createPool(databaseUrl) {
  if (!databaseUrl) return null;

  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ssl: databaseUrl.includes('sslmode=') ? { rejectUnauthorized: false } : false
  });
}

function normaliseFilter(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

function mapBiscuit(row) {
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    office: row.office,
    location: row.location,
    type: row.biscuit_type,
    quantity: Number(row.quantity),
    riskLevel: row.risk_level,
    notes: row.notes,
    updatedAt: row.updated_at
  };
}

function filterMockBiscuits(filters) {
  const search = filters.search.toLowerCase();
  return biscuitRows
    .map((row, index) => mapBiscuit({
      id: index + 1,
      name: row[0],
      department: row[1],
      office: row[2],
      location: row[3],
      biscuit_type: row[4],
      quantity: row[5],
      risk_level: row[6],
      notes: row[7],
      updated_at: new Date().toISOString()
    }))
    .filter((biscuit) => !search || [
      biscuit.name,
      biscuit.department,
      biscuit.office,
      biscuit.location,
      biscuit.type,
      biscuit.notes
    ].some((value) => value.toLowerCase().includes(search)))
    .filter((biscuit) => !filters.department || biscuit.department === filters.department)
    .filter((biscuit) => !filters.location || biscuit.location === filters.location);
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
        await pool.query(`
          CREATE TABLE IF NOT EXISTS public.biscuits (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            department TEXT NOT NULL,
            office TEXT NOT NULL,
            location TEXT NOT NULL,
            biscuit_type TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity >= 0),
            risk_level TEXT NOT NULL,
            notes TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (name, department, office)
          )
        `);

        const statusCount = await pool.query('SELECT COUNT(*) AS row_count FROM public.service_status');
        if (Number(statusCount.rows[0].row_count) === 0) {
          for (const row of serviceStatusRows) {
            await pool.query(
              'INSERT INTO public.service_status (service_name, status, summary) VALUES ($1, $2, $3)',
              row
            );
          }
        }

        const biscuitCount = await pool.query('SELECT COUNT(*) AS row_count FROM public.biscuits');
        if (Number(biscuitCount.rows[0].row_count) === 0) {
          for (const row of biscuitRows) {
            await pool.query(
              `INSERT INTO public.biscuits
                (name, department, office, location, biscuit_type, quantity, risk_level, notes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
        service: 'Emergency Biscuit Service',
        status: 'degraded',
        summary: 'The API is running in local mock mode without PostgreSQL.',
        updatedAt: new Date().toISOString(),
        source: 'mock',
        database: { reachable: false, state: 'not-configured' }
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
        source: 'database',
        database: { reachable: true, state: 'connected' }
      });
    } catch (error) {
      console.error(JSON.stringify({ severity: 'error', service: 'backend', event: 'postgres-query-failed', message: error.message }));
      return res.status(503).json({
        service: 'Emergency Biscuit Service',
        status: 'unavailable',
        summary: 'PostgreSQL is unavailable. Biscuit accountability has been temporarily suspended.',
        updatedAt: new Date().toISOString(),
        source: 'database-error',
        database: { reachable: false, state: 'unavailable' }
      });
    }
  });

  app.get('/api/biscuits', async (req, res) => {
    const filters = {
      search: normaliseFilter(req.query.search),
      department: normaliseFilter(req.query.department),
      location: normaliseFilter(req.query.location)
    };

    if (!pool) {
      const results = filterMockBiscuits(filters);
      return res.json({
        status: 'degraded',
        source: 'mock',
        summary: 'Local mock results are shown because PostgreSQL is not configured.',
        database: { reachable: false, state: 'not-configured' },
        filters,
        count: results.length,
        results
      });
    }

    try {
      await initializeDatabase();
      const conditions = [];
      const parameters = [];

      if (filters.search) {
        parameters.push(`%${filters.search}%`);
        conditions.push(`(
          name ILIKE $${parameters.length}
          OR department ILIKE $${parameters.length}
          OR office ILIKE $${parameters.length}
          OR location ILIKE $${parameters.length}
          OR biscuit_type ILIKE $${parameters.length}
          OR notes ILIKE $${parameters.length}
        )`);
      }
      if (filters.department) {
        parameters.push(filters.department);
        conditions.push(`department = $${parameters.length}`);
      }
      if (filters.location) {
        parameters.push(filters.location);
        conditions.push(`location = $${parameters.length}`);
      }

      const result = await pool.query(`
        SELECT id, name, department, office, location, biscuit_type, quantity, risk_level, notes, updated_at
        FROM public.biscuits
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY department, office, name
        LIMIT 50
      `, parameters);

      return res.json({
        status: 'healthy',
        source: 'database',
        summary: 'Live biscuit records returned from PostgreSQL over the private network.',
        database: { reachable: true, state: 'connected' },
        filters,
        count: result.rows.length,
        results: result.rows.map(mapBiscuit)
      });
    } catch (error) {
      console.error(JSON.stringify({
        severity: 'error',
        service: 'backend',
        event: 'biscuit-search-failed',
        message: error.message,
        filters
      }));
      return res.status(503).json({
        status: 'unavailable',
        source: 'database-error',
        summary: 'The API is available, but PostgreSQL cannot be reached over the private network.',
        database: { reachable: false, state: 'unavailable' },
        filters,
        count: 0,
        results: []
      });
    }
  });

  app.locals.close = async () => {
    if (pool) await pool.end();
  };

  return app;
}

module.exports = { biscuitRows, createApp };
