# Docs

Contexto do projeto — útil tanto pra humanos lendo o código quanto pra agents navegando.

## Produção

Deploy no Railway: **https://teste-dev-monest-production.up.railway.app**
Swagger: https://teste-dev-monest-production.up.railway.app/docs

| Arquivo | Quando ler |
|---|---|
| [ARQUITETURA.md](./ARQUITETURA.md) | Primeira leitura. Visão geral, stack, folder structure, decisões |
| [FLUXO.md](./FLUXO.md) | Entender o fluxo de uma requisição ponta-a-ponta |
| [PROVIDERS.md](./PROVIDERS.md) | Mexer nos providers, adicionar um novo, entender round-robin |
| [ERRORS.md](./ERRORS.md) | Entender a taxonomia de erros e o exception filter |
| [CIRCUIT-BREAKER.md](./CIRCUIT-BREAKER.md) | Mexer em resiliência / tuning do opossum |
| [RATE-LIMIT.md](./RATE-LIMIT.md) | Config de rate limit, tuning, storage per-instance |
| [CACHE.md](./CACHE.md) | Entender estratégia de cache e tradeoffs |
| [OBSERVABILIDADE.md](./OBSERVABILIDADE.md) | Instrumentação, métricas, logs, integração New Relic |
| [TESTES.md](./TESTES.md) | Estratégia e cenários críticos |
| [SETUP.md](./SETUP.md) | Rodar local, Docker, variáveis de ambiente |

## Princípios de design

1. **Resiliência sem over-engineering**: timeout + circuit breaker + fallback + cache. Nada de fila, Redis, retry com backoff elaborado.
2. **Abstração pragmática**: providers atrás de uma interface simples. Adicionar novo = criar classe + registrar.
3. **Erros são tipados**: cada tipo de falha tem uma classe; fluxo decide em `instanceof`, não em strings.
4. **Observabilidade padrão aberto**: OpenTelemetry → qualquer vendor (New Relic neste caso).
5. **Teste o design, não a cobertura**: fallback, 404-short-circuit, circuito aberto, contrato quebrado.
