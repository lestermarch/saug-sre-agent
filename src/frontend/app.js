const express = require('express');
const nunjucks = require('nunjucks');
const path = require('node:path');

const SERVICE_NAME = 'Government Biscuit Location Service';
const departments = [
  'Cabinet Office',
  'Department for Culture, Media and Sport',
  'Department for Education',
  'Department for Environment, Food and Rural Affairs',
  'Department for Science, Innovation and Technology',
  'Department for Transport',
  'Department for Work and Pensions',
  'Department of Health and Social Care',
  'Foreign, Commonwealth and Development Office',
  'HM Treasury',
  'Home Office',
  'Ministry of Justice'
];
const locations = ['Croydon', 'East Kilbride', 'Leeds', 'London', 'Manchester', 'Newcastle', 'Sheffield', 'York'];

function normaliseQuery(query) {
  return {
    search: typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '',
    department: departments.includes(query.department) ? query.department : '',
    location: locations.includes(query.location) ? query.location : ''
  };
}

function connectionState({ apiReachable, databaseReachable, databaseState }) {
  return {
    api: apiReachable
      ? { label: 'API available', tagClass: 'govuk-tag--green' }
      : { label: 'API unavailable', tagClass: 'govuk-tag--red' },
    database: databaseReachable
      ? { label: 'Database reachable', tagClass: 'govuk-tag--green' }
      : databaseState === 'not-configured'
        ? { label: 'Database not configured', tagClass: 'govuk-tag--yellow' }
        : databaseState === 'unknown'
          ? { label: 'Database status unknown', tagClass: 'govuk-tag--grey' }
          : { label: 'Database unavailable', tagClass: 'govuk-tag--red' }
  };
}

function presentResults(results) {
  return Array.isArray(results) ? results.map((biscuit) => ({
    ...biscuit,
    riskTagClass: {
      high: 'govuk-tag--red',
      medium: 'govuk-tag--yellow',
      low: 'govuk-tag--green'
    }[biscuit.riskLevel] || 'govuk-tag--grey'
  })) : [];
}

async function fetchBiscuits({ backendUrl, fetchImpl, timeoutMs, logger, filters }) {
  const endpoint = new URL('/api/biscuits', `${backendUrl.replace(/\/$/, '')}/`);
  for (const [name, value] of Object.entries(filters)) {
    if (value) endpoint.searchParams.set(name, value);
  }

  try {
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json();
    if (!response.ok && data?.source !== 'database-error') {
      throw new Error(`backend returned HTTP ${response.status}`);
    }
    return {
      ...data,
      results: presentResults(data?.results),
      apiReachable: true,
      databaseReachable: data?.database?.reachable === true,
      databaseState: data?.database?.state || 'unknown'
    };
  } catch (error) {
    logger.warn(`Biscuit API unavailable: ${error.message}`);
    return {
      status: 'unavailable',
      source: 'api-error',
      summary: 'The biscuit API cannot be reached. Search requests are not reaching the database.',
      database: { reachable: false, state: 'unknown' },
      count: 0,
      results: [],
      apiReachable: false,
      databaseReachable: false,
      databaseState: 'unknown'
    };
  }
}

function selectOptions(values, selected, emptyLabel) {
  return [
    { value: '', text: emptyLabel, selected: !selected },
    ...values.map((value) => ({ value, text: value, selected: value === selected }))
  ];
}

function createApp(options = {}) {
  const app = express();
  const viewsPath = path.join(__dirname, 'views');
  const govukPath = path.dirname(require.resolve('govuk-frontend/package.json'));
  const govukDistPath = path.join(govukPath, 'dist');
  const govukAssetsPath = path.join(govukDistPath, 'govuk', 'assets');
  const backendUrl = options.backendUrl || process.env.BACKEND_URL || 'http://localhost:8081';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 5000;
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
      const filters = normaliseQuery(request.query);
      const data = await fetchBiscuits({ backendUrl, fetchImpl, timeoutMs, logger, filters });
      response.set('Cache-Control', 'no-store').render('index', {
        serviceName: SERVICE_NAME,
        filters,
        departmentOptions: selectOptions(departments, filters.department, 'All departments'),
        locationOptions: selectOptions(locations, filters.location, 'All locations'),
        connection: connectionState(data),
        search: data
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

module.exports = { connectionState, createApp, fetchBiscuits, normaliseQuery };
