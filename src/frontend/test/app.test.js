const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { createApp } = require('../app');

const servers = [];
const silentLogger = { warn() {}, error() {} };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function databaseResponse(results = []) {
  return new Response(JSON.stringify({
    status: 'healthy',
    source: 'database',
    summary: 'Live records returned.',
    database: { reachable: true, state: 'connected' },
    count: results.length,
    results
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('renders searchable database results with canonical GOV.UK assets', async () => {
  let requestedUrl;
  const app = createApp({
    backendUrl: 'http://backend.example/base',
    fetchImpl: async (url, options) => {
      requestedUrl = url.toString();
      assert.equal(options.headers.accept, 'application/json');
      return databaseResponse([{
        name: '<script>alert("crumbs")</script>',
        department: 'Cabinet Office',
        office: 'COBR snack annex',
        location: 'London',
        type: 'Sandwich biscuit',
        quantity: 148,
        riskLevel: 'low',
        notes: 'All biscuits accounted for.'
      }]);
    },
    logger: silentLogger
  });

  const response = await fetch(`${await listen(app)}/?search=custard&department=Cabinet%20Office&location=London`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(requestedUrl, /\/api\/biscuits\?/);
  assert.match(requestedUrl, /search=custard/);
  assert.match(requestedUrl, /department=Cabinet\+Office/);
  assert.match(html, /API available/);
  assert.match(html, /Database reachable/);
  assert.match(html, /class="connection-status govuk-list"/);
  assert.match(html, /Choose a department, or search all departments/);
  assert.match(html, /href="\/stylesheets\/app\.css"/);
  assert.match(html, /Search biscuit register/);
  assert.match(html, /Live records from the biscuit register/);
  assert.match(html, /&lt;script&gt;alert\(&quot;crumbs&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("crumbs"\)<\/script>/);
});

test('distinguishes a reachable API from a failed database', async () => {
  const app = createApp({
    backendUrl: 'http://backend.example',
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'unavailable',
      source: 'database-error',
      summary: 'PostgreSQL unavailable.',
      database: { reachable: false, state: 'unavailable' },
      count: 0,
      results: []
    }), { status: 503, headers: { 'content-type': 'application/json' } }),
    logger: silentLogger
  });

  const html = await (await fetch(`${await listen(app)}/`)).text();
  assert.match(html, /API available/);
  assert.match(html, /Database unavailable/);
  assert.match(html, /cannot reach PostgreSQL over the private network/);
});

test('shows an API failure without implying the database responded', async () => {
  const app = createApp({
    backendUrl: 'http://backend.example',
    fetchImpl: async () => { throw new Error('connection refused'); },
    logger: silentLogger
  });

  const html = await (await fetch(`${await listen(app)}/`)).text();
  assert.match(html, /API unavailable/);
  assert.match(html, /Database status unknown/);
  assert.match(html, /Searches cannot be processed/);
});

test('exposes health endpoints and serves GOV.UK assets locally', async () => {
  const baseUrl = await listen(createApp({ logger: silentLogger }));

  for (const [path, expected] of [
    ['/health/live', 'alive'],
    ['/health/ready', 'ready'],
    ['/health', 'ok']
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: expected, service: 'frontend' });
  }

  for (const path of [
    '/stylesheets/govuk-frontend.min.css',
    '/stylesheets/app.css',
    '/javascripts/govuk-frontend.min.js',
    '/assets/fonts/bold-b542beb274-v2.woff2'
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
  }
});
