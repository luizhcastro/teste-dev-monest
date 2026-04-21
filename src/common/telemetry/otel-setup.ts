import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const apiKey = process.env.NEW_RELIC_LICENSE_KEY;

if (endpoint && apiKey) {
  const commonConfig = {
    url: endpoint,
    headers: { 'api-key': apiKey },
  };

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'cep-api',
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? 'dev',
    }),
    traceExporter: new OTLPTraceExporter(commonConfig),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(commonConfig),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [new HttpInstrumentation(), new NestInstrumentation()],
  });

  sdk.start();

  const shutdown = (): void => {
    void sdk
      .shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
