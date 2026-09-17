const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { createApp } = require('../app');

const servers = [];
const silentLogger = { warn() {}, error() {} };

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('renders backend status with canonical GOV.UK assets and escaped content', async () => {
  let requestedUrl;
  const app = createApp({
    backendUrl: 'http://backend.example/base',
    fetchImpl: async (url, options) => {
      requestedUrl = url.toString();
      assert.equal(options.headers.accept, 'application/json');
      return new Response(JSON.stringify({
        service: '<script>alert("crumbs")</script>',
        status: 'healthy',
        summary: 'All biscuits accounted for.',
        updatedAt: '2026-09-17T08:00:00Z'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: silentLogger
  });

  const response = await fetch(`${await listen(app)}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(requestedUrl, 'http://backend.example/base/api/status');
  assert.match(html, /<html[^>]+class="[^"]*govuk-template/);
  assert.match(html, /govuk-phase-banner/);
  assert.match(html, /govuk-summary-list/);
  assert.match(html, /href="\/stylesheets\/govuk-frontend\.min\.css"/);
  assert.match(html, /from '\/javascripts\/govuk-frontend\.min\.js'/);
  assert.match(html, /All biscuits accounted for\./);
  assert.match(html, /&lt;script&gt;alert\(&quot;crumbs&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("crumbs"\)<\/script>/);
});

test('renders a clear degraded fallback when the backend is unavailable', async () => {
  const app = createApp({
    backendUrl: 'http://backend.example',
    fetchImpl: async () => { throw new Error('connection refused'); },
    logger: silentLogger
  });

  const response = await fetch(`${await listen(app)}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Some problems/);
  assert.match(html, /Live status is not available/);
  assert.match(html, /SRE team has put the kettle on/);
  assert.match(html, /Not available/);
});

test('exposes liveness, readiness and backwards-compatible health endpoints', async () => {
  const baseUrl = await listen(createApp({ logger: silentLogger }));

  for (const [path, status] of [
    ['/health/live', 'alive'],
    ['/health/ready', 'ready'],
    ['/health', 'ok']
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { status, service: 'frontend' });
  }
});

test('serves GOV.UK Frontend CSS, JavaScript and font assets locally', async () => {
  const baseUrl = await listen(createApp({ logger: silentLogger }));

  for (const path of [
    '/stylesheets/govuk-frontend.min.css',
    '/javascripts/govuk-frontend.min.js',
    '/assets/fonts/bold-b542beb274-v2.woff2'
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok(Number(response.headers.get('content-length')) > 100, path);
  }
});


