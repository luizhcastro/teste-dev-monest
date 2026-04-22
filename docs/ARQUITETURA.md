# Arquitetura

## Visão geral
API NestJS que expõe `GET /cep/:cep`. Consulta providers externos (ViaCEP, BrasilAPI) com **round-robin**, **fallback automático**, **circuit breaker por provider**, **cache em memória**, **rate limit por IP** e **observabilidade via OpenTelemetry → New Relic**.

## Stack

| Dependência | Por quê |
|---|---|
| `@nestjs/*` | Requisito do desafio. DI ajuda a plugar providers. |
| **`fetch` nativo (Node 20+)** | Built-in, zero dependência, `AbortSignal.timeout()` nativo, `Response` WHATWG-padrão. Axios seria peso extra sem ganho. |
| `opossum` | Circuit breaker maduro, API simples, eventos pra telemetria. |
| `@nestjs/throttler` | Rate limit in-memory com guard global. Zero infra. |
| `@nestjs/swagger` | OpenAPI auto-gerado a partir de decorators. UI em `/docs`. |
| `lru-cache` v11 | LRU in-process com TTL. Zero infra. |
| `zod` | Validação de schema. Usado tanto em env quanto em resposta de providers. |
| `nestjs-pino` + `pino` | Logger estruturado rápido, com pino-http já ligado no Nest. |
| `@opentelemetry/*` | Traces + métricas. Exporter OTLP pro New Relic. |
| `@nestjs/testing` + `supertest` | Test runner e E2E. |

## Estrutura de pastas

```
src/
  main.ts                         # bootstrap + OTel (antes do Nest)
  app.module.ts
  cep/
    cep.module.ts
    cep.controller.ts
    cep.service.ts                # orquestra cache → selector → providers
    dto/
      cep-param.dto.ts            # pipe + normalizeCep() (remove hífen, valida \d{8})
      cep-response.dto.ts
    errors/
      cep.errors.ts               # hierarquia de erros
    providers/
      cep-provider.interface.ts   # + token CEP_PROVIDERS
      viacep.provider.ts
      brasilapi.provider.ts
      fetch-error.mapper.ts       # AbortError → ProviderTimeout, resto → ProviderNetwork
      provider-selector.service.ts
      circuit-breaker.factory.ts
    cache/
      cep-cache.service.ts
    schemas/
      viacep.schema.ts            # Zod
      brasilapi.schema.ts
  common/
    dto/
      error-response.dto.ts       # Swagger schema p/ erros + attempts
    filters/
      cep-exception.filter.ts     # mapeia erros → HTTP (inclui 429)
    middleware/
      correlation-id.middleware.ts
    throttler/
      throttler.module.ts         # @nestjs/throttler + APP_GUARD global
      custom-throttler.guard.ts   # converte bloqueio em RateLimitExceededError
    logging/
      logger.module.ts            # nestjs-pino + mixin com traceId/spanId
    telemetry/
      otel-setup.ts
      tracer.ts                   # tracer + 9 métricas (inclui rate_limit)
  config/
    config.module.ts
    env.validation.ts             # Zod no process.env
  health/
    health.module.ts
    health.controller.ts          # /health/live + /health/ready
test/
  fixtures/mock-cep-data.ts
  unit/                           # service, selector, pipe, health
  integration/                    # providers com jest.spyOn(globalThis, 'fetch')
  e2e/                            # endpoint completo com supertest
  jest-e2e.json
Dockerfile                        # multi-stage (deps / build / runtime) + tini
docker-compose.yml                # healthcheck + log rotation
Makefile                          # conveniência: make dev, make docker, make test
.env.example
.dockerignore
```

## Módulos

- **AppModule** — bootstrap, ConfigModule, ThrottlerModule, CepModule, HealthModule, middleware de correlation-id aplicado globalmente
- **CepModule** — controller + service + providers (multi-provider DI) + cache + circuit breaker factory
- **ConfigModule** — valida `process.env` com zod; falha fast se inválido
- **ThrottlerModule** — registra `@nestjs/throttler` + `CustomThrottlerGuard` via `APP_GUARD`
- **HealthModule** — liveness + readiness probes (rotas `/health/*` com `@SkipThrottle`)

## Fluxo de alto nível

```
Request
  └─> correlation-id middleware
        └─> ThrottlerGuard (rate limit por IP; skip em /health/*)
              └─> CepController (valida param)
                    └─> CepService
                    ├─> CacheService.get → hit? retorna
                    └─> ProviderSelector.getOrder()
                          └─> for provider in order:
                                └─> CircuitBreakerFactory.get(provider).fire()
                                      ├─> sucesso → cacheia → retorna
                                      ├─> 404 → throw (sem fallback)
                                      └─> outro erro → próximo
                    └─> Todos falharam → AllProvidersUnavailableError
```

Detalhes em [FLUXO.md](./FLUXO.md).

## Decisões arquiteturais

### DI dos providers via `useFactory` (Nest não tem `multi: true` como Angular)
```ts
providers: [
  ViaCepProvider,
  BrasilApiProvider,
  {
    provide: CEP_PROVIDERS,
    useFactory: (viacep: ViaCepProvider, brasilapi: BrasilApiProvider) => [
      viacep,
      brasilapi,
    ],
    inject: [ViaCepProvider, BrasilApiProvider],
  },
]
```
`ProviderSelectorService` recebe o array inteiro via `@Inject(CEP_PROVIDERS)`. Adicionar provider = adicionar classe + linha na factory.

### Circuit breaker por provider, não global
ViaCEP degradado não deve derrubar BrasilAPI. Um `Map<providerName, CircuitBreaker>` no factory.

### Cache antes do selector
Hit evita tudo: seleção, chamada, circuit. Chave = CEP normalizado (8 dígitos, sem hífen).

### Zod nas respostas externas
API externa pode mudar contrato silenciosamente. Validação transforma mudança silenciosa em erro explícito → fallback. Detalhes em [PROVIDERS.md](./PROVIDERS.md).

### OTel inicializado antes do Nest
Instrumentações auto (http, nest) precisam registrar hooks antes do app subir. `import './common/telemetry/otel-setup'` é a **primeira linha** de `main.ts`.
