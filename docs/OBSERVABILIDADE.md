# Observabilidade

Três pilares: **logs** (pino), **traces** (OpenTelemetry), **métricas** (OpenTelemetry).
Export via OTLP para o **New Relic**.

## Por que OpenTelemetry em vez do agent do New Relic?

| Aspecto | OTel + OTLP | Agent nativo NR |
|---|---|---|
| Portabilidade | Trocar vendor = trocar URL | Lock-in |
| Padrão | Open standard, CNCF | Proprietário |
| Instrumentação | Auto (http, nest, axios) | Auto |
| Suporte NR | OTLP nativo, feature parity | — |
| Curva | Mais verboso no setup | Mais simples |

New Relic consome OTLP nativamente — **não perde nenhum recurso**. Se amanhã for Datadog, Grafana, Honeycomb, é só trocar o endpoint.

## Setup

```ts
// src/common/telemetry/otel-setup.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

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
    instrumentations: [
      new HttpInstrumentation(),
      new NestInstrumentation(),
    ],
  });

  sdk.start();

  process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
}
```

**Importante:** isto precisa rodar **antes** de `NestFactory.create()`. Importar como **primeira linha** de `main.ts`:

```ts
// main.ts
import './common/telemetry/otel-setup';  // PRIMEIRO
import { NestFactory } from '@nestjs/core';
// ...
```

## Env vars

```
OTEL_SERVICE_NAME=cep-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net:4318
NEW_RELIC_LICENSE_KEY=<license-key>
```

Sem `NEW_RELIC_LICENSE_KEY` definida → SDK não sobe, app funciona normal (dev local sem NR).

## Correlation ID

```ts
// src/common/middleware/correlation-id.middleware.ts
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers['x-correlation-id'] as string) ?? randomUUID();
    (req as any).correlationId = id;
    res.setHeader('X-Correlation-Id', id);

    const span = trace.getActiveSpan();
    span?.setAttribute('correlation.id', id);

    next();
  }
}
```

Aplicado globalmente em `AppModule.configure()`.

## Spans custom

```ts
const tracer = trace.getTracer('cep-api');

async lookup(cep: string): Promise<CepResponse> {
  return tracer.startActiveSpan('cep.lookup', async (span) => {
    span.setAttribute('cep', cep);
    try {
      const result = await this.doLookup(cep);
      span.setAttribute('cep.cached', result.cached);
      span.setAttribute('cep.provider', result.provider);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### Estrutura de spans de uma request

```
HTTP GET /cep/:cep                (auto, HttpInstrumentation)
└── cep.lookup                    (service)
    ├── cep.cache.get
    ├── cep.provider.brasilapi    (se chamou)
    │   └── HTTP GET viacep...    (auto)
    ├── cep.provider.viacep       (se fallback)
    └── cep.cache.set
```

## Métricas

```ts
// src/common/telemetry/tracer.ts
const meter = metrics.getMeter('cep-api');

export const cepLookupTotal = meter.createCounter('cep_lookup_total');
export const cepLookupDuration = meter.createHistogram('cep_lookup_duration_seconds');
export const providerRequestsTotal = meter.createCounter('cep_provider_requests_total');
export const providerDuration = meter.createHistogram('cep_provider_duration_seconds');
export const circuitStateGauge = meter.createUpDownCounter('cep_circuit_state');
export const cacheHitsTotal = meter.createCounter('cep_cache_hits_total');
export const cacheMissesTotal = meter.createCounter('cep_cache_misses_total');
export const cacheStaleHitsTotal = meter.createCounter('cep_cache_stale_hits_total');
```

### Tabela

| Métrica | Tipo | Atributos |
|---|---|---|
| `cep_lookup_total` | counter | `status` (ok, not_found, all_failed, cached) |
| `cep_lookup_duration_seconds` | histogram | `status` |
| `cep_provider_requests_total` | counter | `provider`, `outcome` (ok, timeout, http_error, network_error, contract_error, not_found) |
| `cep_provider_duration_seconds` | histogram | `provider`, `outcome` |
| `cep_circuit_state` | gauge | `provider` — 0=closed, 1=half, 2=open |
| `cep_cache_hits_total` | counter | — |
| `cep_cache_misses_total` | counter | — |
| `cep_cache_stale_hits_total` | counter | — |

## Logs (pino)

```ts
// src/common/logging/logger.ts
import pino from 'pino';
import { trace } from '@opentelemetry/api';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin: () => {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const ctx = span.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
    };
  },
});
```

### Campos padrão em todo log
- `correlationId`
- `traceId`, `spanId` (auto via mixin — permite linkar log ↔ trace no NR)
- `cep` (quando aplicável)
- `provider` (quando aplicável)
- `durationMs` (quando aplicável)

### Níveis por evento
| Nível | Evento |
|---|---|
| DEBUG | Cada tentativa de provider iniciada |
| INFO | Request completo (método, path, status, duration) |
| INFO | Cache hit/miss |
| WARN | Fallback disparado, circuit opened/half-open |
| ERROR | Erro inesperado, contract violation |

## Dashboard no New Relic (NRQL)

```sql
-- Request rate e latência (p50, p95, p99)
FROM Metric SELECT
  rate(count(cep_lookup_total), 1 minute) AS rpm,
  percentile(cep_lookup_duration_seconds, 50, 95, 99) AS latency
TIMESERIES SINCE 1 hour ago FACET status
```

```sql
-- Uso por provider
FROM Metric SELECT sum(cep_provider_requests_total)
SINCE 1 hour ago FACET provider, outcome
```

```sql
-- Estado dos circuitos
FROM Metric SELECT latest(cep_circuit_state)
FACET provider TIMESERIES SINCE 1 hour ago
```

```sql
-- Cache hit ratio
FROM Metric SELECT
  sum(cep_cache_hits_total) / (sum(cep_cache_hits_total) + sum(cep_cache_misses_total)) * 100
  AS hit_rate_percent
TIMESERIES
```

```sql
-- Top CEPs consultados (se logar cep como atributo)
FROM Log SELECT count(*) FACET cep SINCE 1 day ago LIMIT 20
```

## Alerts sugeridos

| Alert | Condition |
|---|---|
| Circuit aberto | `latest(cep_circuit_state) >= 2` por mais de 1 minuto |
| Hit rate baixo | `cache_hits / total < 0.5` por 10 minutos (warm-up aceitável) |
| p95 latência alta | `percentile(cep_lookup_duration_seconds, 95) > 2s` |
| Taxa de 503 | `cep_lookup_total{status='all_failed'}` > 0 |
