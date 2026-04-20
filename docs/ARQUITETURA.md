# Arquitetura

## Visão geral
API NestJS que expõe `GET /cep/:cep`. Consulta providers externos (ViaCEP, BrasilAPI) com **round-robin**, **fallback automático**, **circuit breaker por provider**, **cache em memória** e **observabilidade via OpenTelemetry → New Relic**.

## Stack

| Dependência | Por quê |
|---|---|
| `@nestjs/*` | Requisito do desafio. DI ajuda a plugar providers. |
| `axios` | HTTP client. Pode ser `fetch` nativo, mas axios tem interceptors úteis. |
| `opossum` | Circuit breaker maduro, API simples, eventos pra telemetria. |
| `lru-cache` | LRU in-process com TTL. Zero infra. |
| `zod` | Validação de schema. Usado tanto em env quanto em resposta de providers. |
| `pino` | Logger estruturado rápido. |
| `@opentelemetry/*` | Traces + métricas. Exporter OTLP pro New Relic. |
| `nock` (dev) | Mock HTTP em testes. |

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
      cep-param.dto.ts            # valida + normaliza o :cep
      cep-response.dto.ts
    errors/
      cep.errors.ts               # hierarquia de erros
    providers/
      cep-provider.interface.ts
      viacep.provider.ts
      brasilapi.provider.ts
      provider-selector.service.ts
      circuit-breaker.factory.ts
    cache/
      cep-cache.service.ts
    schemas/
      viacep.schema.ts            # Zod
      brasilapi.schema.ts
  common/
    filters/
      cep-exception.filter.ts     # mapeia erros → HTTP
    middleware/
      correlation-id.middleware.ts
    logging/
      logger.ts
    telemetry/
      otel-setup.ts
      tracer.ts
  config/
    config.module.ts
    env.validation.ts             # Zod no process.env
  health/
    health.controller.ts          # /health/live + /health/ready
test/
  unit/
  integration/
  e2e/
```

## Módulos

- **AppModule** — bootstrap, ConfigModule, CepModule, HealthModule, middleware de correlation-id aplicado globalmente
- **CepModule** — controller + service + providers (multi-provider DI) + cache + circuit breaker factory
- **ConfigModule** — valida `process.env` com zod; falha fast se inválido
- **HealthModule** — liveness + readiness probes

## Fluxo de alto nível

```
Request
  └─> correlation-id middleware
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

### DI dos providers com multi-provider
```ts
providers: [
  { provide: CEP_PROVIDERS, useClass: ViaCepProvider, multi: true },
  { provide: CEP_PROVIDERS, useClass: BrasilApiProvider, multi: true },
]
```
`ProviderSelectorService` recebe o array inteiro. Adicionar provider = uma linha no módulo.

### Circuit breaker por provider, não global
ViaCEP degradado não deve derrubar BrasilAPI. Um `Map<providerName, CircuitBreaker>` no factory.

### Cache antes do selector
Hit evita tudo: seleção, chamada, circuit. Chave = CEP normalizado (8 dígitos, sem hífen).

### Zod nas respostas externas
API externa pode mudar contrato silenciosamente. Validação transforma mudança silenciosa em erro explícito → fallback. Detalhes em [PROVIDERS.md](./PROVIDERS.md).

### OTel inicializado antes do Nest
Instrumentações auto (http, nest) precisam registrar hooks antes do app subir. `import './common/telemetry/otel-setup'` é a **primeira linha** de `main.ts`.
