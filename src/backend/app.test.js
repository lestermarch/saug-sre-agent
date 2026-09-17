const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createApp } = require('./app');

let server;
let baseUrl;

before(async () => {
  const app = createApp({ databaseUrl: '' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('liveness endpoint reports ok', async () => {
  const response = await fetch(`${baseUrl}/health/live`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'backend' });
});

test('readiness reports missing PostgreSQL configuration', async () => {
  const response = await fetch(`${baseUrl}/health/ready`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).dependency, 'postgres');
});

test('status endpoint supplies local mock data', async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'mock');
  assert.equal(body.status, 'healthy');
});
