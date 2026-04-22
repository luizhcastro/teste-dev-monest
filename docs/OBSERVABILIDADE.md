# Observabilidade

Três pilares: **logs** (pino), **traces** (OpenTelemetry), **métricas** (OpenTelemetry).
Export via OTLP para o **New Relic**.

## Por que OpenTelemetry em vez do agent do New Relic?

| Aspecto | OTel + OTLP | Agent nativo NR |
|---|---|---|
| Portabilidade | Trocar vendor = trocar URL | Lock-in |
| Padrão | Open standard, CNCF | Proprietário |
| Instrumentação | Auto (http, nestjs-core) | Auto |
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

  const shutdown = () => {
    void sdk.shutdown().catch(() => undefined).finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
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

O `pino-http` (via `nestjs-pino`) já faz o trabalho pesado através do `genReqId`:
lê `X-Correlation-Id` do request ou gera UUID, seta no response header e
atribui em `req.id`. O middleware apenas **publica** esse id no request object
e no span ativo do OTel:

```ts
// src/common/middleware/correlation-id.middleware.ts
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const r = req as Request & { id?: string | number; correlationId: string };
    const id = (r.id !== undefined ? String(r.id) : undefined) ?? randomUUID();

    r.correlationId = id;
    if (!res.getHeader('X-Correlation-Id')) {
      res.setHeader('X-Correlation-Id', id);
    }

    const span = trace.getActiveSpan();
    span?.setAttribute('correlation.id', id);

    next();
  }
}
```

```ts
// src/common/logging/logger.module.ts — genReqId no pino-http
genReqId: (req, res) => {
  const incoming = req.headers['x-correlation-id'];
  const id = (typeof incoming === 'string' && incoming.trim()) || randomUUID();
  res.setHeader('X-Correlation-Id', id);
  return id;
},
```

Middleware aplicado globalmente em `AppModule.configure()`.

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
└── cep.lookup                    (service, único span custom)
    ├── HTTP GET brasilapi...     (auto, HttpInstrumentation)
    └── HTTP GET viacep...        (auto, se fallback)
```

`cep.lookup` é o único span criado manualmente. Chamadas a providers aparecem como spans HTTP automáticos (filhos herdam contexto do `cep.lookup` ativo). Atributos custom no `cep.lookup`:

- `cep` — CEP consultado
- `cep.cached` — `true` se veio de cache
- `cep.stale` — `true` se cache stale serviu fallback
- `cep.provider` — provider que atendeu
- `cep.attempts` — quantidade de tentativas antes do sucesso

## Métricas

```ts
// src/common/telemetry/tracer.ts
const meter = metrics.getMeter('cep-api');

export const cepLookupTotal = meter.createCounter('cep_lookup_total');
export const cepLookupDuration = meter.createHistogram('cep_lookup_duration_seconds');
export const providerRequestsTotal = meter.createCounter('cep_provider_requests_total');
export const providerDuration = meter.createHistogram('cep_provider_duration_seconds');
export const circuitStateGauge = meter.createObservableGauge('cep_circuit_state');
export const cacheHitsTotal = meter.createCounter('cep_cache_hits_total');
export const cacheMissesTotal = meter.createCounter('cep_cache_misses_total');
export const cacheStaleHitsTotal = meter.createCounter('cep_cache_stale_hits_total');
export const rateLimitExceededTotal = meter.createCounter('cep_rate_limit_exceeded_total');
```

### Tabela

| Métrica | Tipo | Atributos |
|---|---|---|
| `cep_lookup_total` | counter | `status` (ok, not_found, all_failed, cached) |
| `cep_lookup_duration_seconds` | histogram | `status` |
| `cep_provider_requests_total` | counter | `provider`, `outcome` (ok, timeout, http_error, network_error, contract_error, not_found) |
| `cep_provider_duration_seconds` | histogram | `provider`, `outcome` |
| `cep_circuit_state` | observable gauge | `provider` — 0=closed, 1=half-open, 2=open |
| `cep_cache_hits_total` | counter | — |
| `cep_cache_misses_total` | counter | — |
| `cep_cache_stale_hits_total` | counter | — |
| `cep_rate_limit_exceeded_total` | counter | — (requests bloqueadas por rate limit) |

### Observable gauge — padrão pull

`circuitStateGauge` não é setado manualmente a cada mudança de estado. Ele
registra um callback no `onModuleInit` do `CircuitBreakerFactory`, e o OTel
invoca esse callback no intervalo de export (10s) para ler o estado atual:

```ts
// src/cep/providers/circuit-breaker.factory.ts
onModuleInit(): void {
  circuitStateGauge.addCallback((result) => {
    for (const { name, breaker } of this.all()) {
      const state = breaker.opened ? 2 : breaker.halfOpen ? 1 : 0;
      result.observe(state, { provider: name });
    }
  });
}
```

Vantagem sobre `UpDownCounter`: o valor reportado é sempre o **estado real do
breaker** no momento do export. Sem risco de divergência se um evento `open`/
`close` for perdido.

## Logs (pino via nestjs-pino)

```ts
// src/common/logging/logger.module.ts (resumido)
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { trace } from '@opentelemetry/api';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          transport: isDev ? { target: 'pino-pretty', options: { ... } } : undefined,

          // correlation id: lê header ou gera UUID — seta em req.id + response
          genReqId: (req, res) => { /* ... */ },
          customProps: (req) => ({ correlationId: req.id }),

          // mixin: injeta traceId/spanId em todo log a partir do span ativo
          mixin: () => {
            const span = trace.getActiveSpan();
            if (!span) return {};
            const ctx = span.spanContext();
            return { traceId: ctx.traceId, spanId: ctx.spanId };
          },
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
```

Uso no service: `constructor(private readonly logger: PinoLogger) { this.logger.setContext(CepService.name); }`.

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
| Rate limit pico | `rate(count(cep_rate_limit_exceeded_total), 1m) > N` por 5 minutos (bot ou limite mal dimensionado) |
