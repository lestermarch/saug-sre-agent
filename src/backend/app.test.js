const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { createApp } = require('./app');

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('liveness endpoint reports ok', async () => {
  const response = await fetch(`${await listen(createApp({ databaseUrl: '' }))}/health/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'backend' });
});

test('readiness reports missing PostgreSQL configuration', async () => {
  const response = await fetch(`${await listen(createApp({ databaseUrl: '' }))}/health/ready`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).dependency, 'postgres');
});

test('mock biscuit search supports text and department filters', async () => {
  const baseUrl = await listen(createApp({ databaseUrl: '' }));
  const response = await fetch(`${baseUrl}/api/biscuits?search=quantum&department=Department%20for%20Science%2C%20Innovation%20and%20Technology`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.source, 'mock');
  assert.equal(body.database.reachable, false);
  assert.equal(body.count, 1);
  assert.equal(body.results[0].name, 'Pink Wafer');
});

test('database search uses parameterised filters and reports connectivity', async () => {
  const calls = [];
  const pool = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ row_count: '1' }] };
      if (sql.includes('FROM public.biscuits') && sql.includes('SELECT id')) {
        return {
          rows: [{
            id: 7,
            name: 'Shortbread Finger',
            department: 'Foreign, Commonwealth and Development Office',
            office: 'Diplomatic biscuit pouch',
            location: 'East Kilbride',
            biscuit_type: 'Shortbread',
            quantity: 76,
            risk_level: 'low',
            notes: 'For bilateral tea arrangements.',
            updated_at: '2026-09-17T12:00:00Z'
          }]
        };
      }
      return { rows: [] };
    },
    async end() {}
  };
  const baseUrl = await listen(createApp({ pool }));
  const response = await fetch(`${baseUrl}/api/biscuits?search=tea&location=East%20Kilbride`);
  const body = await response.json();
  const searchCall = calls.find(({ sql }) => sql.includes('SELECT id'));

  assert.equal(response.status, 200);
  assert.equal(body.source, 'database');
  assert.equal(body.database.reachable, true);
  assert.equal(body.results[0].name, 'Shortbread Finger');
  assert.deepEqual(searchCall.parameters, ['%tea%', 'East Kilbride']);
  assert.match(searchCall.sql, /ILIKE \$1/);
  assert.match(searchCall.sql, /location = \$2/);
});

test('database failure distinguishes an available API from unavailable PostgreSQL', async () => {
  const pool = {
    async query() {
      throw new Error('private DNS lookup failed');
    },
    async end() {}
  };
  const response = await fetch(`${await listen(createApp({ pool }))}/api/biscuits`);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.source, 'database-error');
  assert.equal(body.database.reachable, false);
  assert.match(body.summary, /API is available/);
});
