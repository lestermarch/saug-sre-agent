const { useAzureMonitor } = require('@azure/monitor-opentelemetry');

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  useAzureMonitor();
} else {
  console.warn('Application Insights telemetry is disabled because APPLICATIONINSIGHTS_CONNECTION_STRING is not set.');
}

const { createApp } = require('./app');

const port = Number(process.env.PORT || 8080);
const app = createApp();
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Backend API listening on http://0.0.0.0:${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down backend`);
  server.close(async () => {
    await app.locals.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
