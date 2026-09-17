const express = require('express');
const nunjucks = require('nunjucks');
const path = require('node:path');

const SERVICE_NAME = 'Emergency Biscuit Service';
const FALLBACK_STATUS = Object.freeze({
  service: SERVICE_NAME,
  status: 'degraded',
  summary: 'We cannot check the biscuit cupboard right now. The SRE team has put the kettle on.',
  updatedAt: null,
  source: 'fallback'
});

function displayDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/London'
  }).format(date);
}

function normaliseStatus(data) {
  const allowedStatuses = new Set(['healthy', 'degraded', 'unavailable']);
  const status = allowedStatuses.has(data?.status) ? data.status : 'unavailable';

  return {
    service: typeof data?.service === 'string' && data.service.trim() ? data.service : SERVICE_NAME,
    status,
    statusLabel: {
      healthy: 'Available',
      degraded: 'Some problems',
      unavailable: 'Unavailable'
    }[status],
    tagClass: {
      healthy: 'govuk-tag--green',
      degraded: 'govuk-tag--yellow',
      unavailable: 'govuk-tag--red'
    }[status],
    summary: typeof data?.summary === 'string' && data.summary.trim()
      ? data.summary
      : 'No further information is available.',
    updatedAt: displayDate(data?.updatedAt),
    isFallback: data?.source === 'fallback'
  };
}

async function fetchBackendStatus({ backendUrl, fetchImpl, timeoutMs, logger }) {
  try {
    const response = await fetchImpl(`${backendUrl.replace(/\/$/, '')}/api/status`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`backend returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    logger.warn(`Backend status unavailable: ${error.message}`);
    return FALLBACK_STATUS;
  }
}

function createApp(options = {}) {
  const app = express();
  const viewsPath = path.join(__dirname, 'views');
  const govukPath = path.dirname(require.resolve('govuk-frontend/package.json'));
  const govukDistPath = path.join(govukPath, 'dist');
  const govukAssetsPath = path.join(govukDistPath, 'govuk', 'assets');
  const backendUrl = options.backendUrl || process.env.BACKEND_URL || 'http://localhost:8081';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 2000;
  const logger = options.logger || console;

  app.disable('x-powered-by');
  app.set('view engine', 'njk');
  app.set('views', viewsPath);
  nunjucks.configure([govukDistPath, viewsPath], {
    autoescape: true,
    express: app,
    noCache: process.env.NODE_ENV !== 'production'
  });

  app.use('/assets', express.static(govukAssetsPath, { immutable: true, maxAge: '1y' }));
  app.get('/stylesheets/govuk-frontend.min.css', (request, response) => {
    response.sendFile(path.join(govukDistPath, 'govuk', 'govuk-frontend.min.css'));
  });
  app.get('/javascripts/govuk-frontend.min.js', (request, response) => {
    response.sendFile(path.join(govukDistPath, 'govuk', 'govuk-frontend.min.js'));
  });

  function healthResponse(status) {
    return (request, response) => {
      response.set('Cache-Control', 'no-store').json({ status, service: 'frontend' });
    };
  }

  app.get('/health/live', healthResponse('alive'));
  app.get('/health/ready', healthResponse('ready'));
  app.get('/health', healthResponse('ok'));

  app.get('/', async (request, response, next) => {
    try {
      const data = await fetchBackendStatus({ backendUrl, fetchImpl, timeoutMs, logger });
      response.set('Cache-Control', 'no-store').render('index', {
        serviceName: SERVICE_NAME,
        status: normaliseStatus(data)
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, request, response, next) => {
    logger.error(error);
    if (response.headersSent) return next(error);
    return response.status(500).type('text/plain').send('Sorry, there is a problem with the service.');
  });

  return app;
}

module.exports = { createApp, fetchBackendStatus, normaliseStatus };


