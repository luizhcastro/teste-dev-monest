# Rate Limit

Biblioteca: [@nestjs/throttler](https://docs.nestjs.com/security/rate-limiting).

## Para que serve
Proteger a API (e indiretamente os providers externos) contra:
1. **Clientes abusivos** — script mal configurado em loop, bot
2. **Thundering herd self-inflicted** — saturação dos providers pelo nosso próprio tráfego
3. **DoS barato** — baixa a superfície antes de chegar nos providers / circuit breaker

Não substitui um WAF / API gateway — é uma camada **defesa em profundidade** no próprio processo.

## Configuração

```ts
// src/common/throttler/throttler.module.ts
NestThrottlerModule.forRootAsync({
  useFactory: () => [
    {
      name: 'default',
      ttl: Number(process.env.RATE_LIMIT_TTL_MS ?? 60_000),
      limit: Number(process.env.RATE_LIMIT_MAX ?? 60),
    },
  ],
});
```

| Env var | Default | Significado |
|---|---|---|
| `RATE_LIMIT_TTL_MS` | `60000` | Janela deslizante em ms |
| `RATE_LIMIT_MAX` | `60` | Máximo de requests por IP por janela |

Defaults: **60 requests por minuto por IP**. Validação Zod em `env.validation.ts` garante valores inteiros positivos — app não sobe com config inválida.

### Por que `process.env` direto e não `ConfigService`?
O `NestConfigModule.forRoot({ cache: true, isGlobal: true })` cria um `ConfigService` singleton com cache de leituras. Em múltiplos test suites que mutam `process.env` entre si, o cache retorna o valor antigo. Ler `process.env` direto na factory evita esse drift. A validação/coerção de tipos ainda acontece em `ConfigModule.validate` no boot — se `RATE_LIMIT_MAX=banana`, o processo não sobe.

## Storage: in-memory, per-instance

Mesmo tradeoff do [circuit breaker](./CIRCUIT-BREAKER.md): cada processo tem seu próprio contador. Em k8s com N réplicas atrás de um load balancer, o cliente efetivamente enxerga `N × limit` req/min.

### Quando isso importa
- **N pequeno (1–3 réplicas)**: ignorável
- **N grande (10+ réplicas)**: considerar storage distribuído (Redis) via `@nest-lab/throttler-storage-redis`

Para o escopo do desafio, **in-memory vence por simplicidade** (zero infra extra).

## Chave de rate limit

Por padrão, IP do cliente. O guard extrai via `req.ips[0] ?? req.ip ?? socket.remoteAddress`:

```ts
protected async getTracker(req): Promise<string> {
  if (req.ips?.length) return req.ips[0];
  if (req.ip) return req.ip;
  return req.socket?.remoteAddress ?? 'unknown';
}
```

### Atrás de proxy
`req.ips` só é populado se o Express confiar no proxy — setar `app.set('trust proxy', 'loopback')` ou a CIDR do LB. Sem isso, todo mundo aparece com o IP do proxy e **colide na mesma chave**. Como o projeto não fixa topologia de deploy, deixamos a configuração pra quem for rodar em produção.

## Rotas excluídas

`/health/live` e `/health/ready` usam `@SkipThrottle()` no controller — probes de k8s rodam a cada 10-30s e não devem consumir quota:

```ts
@SkipThrottle()
@Controller('health')
export class HealthController { ... }
```

Consequência: `/health/*` nunca retornam 429.

## Erro → HTTP 429

`CustomThrottlerGuard` converte o bloqueio em `RateLimitExceededError` (da mesma hierarquia `CepApiError`), e o exception filter retorna:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json
```
```json
{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded",
  "correlationId": "uuid-v4"
}
```

`Retry-After` é calculado a partir de `timeToBlockExpire` do throttler (em segundos). Cliente pode decidir backoff baseado nesse header.

## Observabilidade

### Métrica
```
cep_rate_limit_exceeded_total  (counter)
```
Incrementa a cada bloqueio. Alerta sugerido:

```sql
FROM Metric SELECT rate(count(cep_rate_limit_exceeded_total), 1 minute)
SINCE 10 minutes ago
```
Crescimento súbito = script malcomportado OU limite mal dimensionado.

### Logs
O request bloqueado já aparece nos logs do `pino-http` com status 429. `correlationId` no body permite linkar com o log do cliente.

## Ordem no pipeline

```
Request
 └─> correlation-id middleware   (seta req.correlationId)
      └─> ThrottlerGuard         (← aqui, antes do pipe)
           └─> CepParamPipe
                └─> CepController.getCep
```

Guard roda **antes** do pipe de validação — um cliente abusivo mandando `/cep/abc` também consome quota. Isso é intencional: validação ainda gasta CPU e logs.

## Fluxo de um 429

```
51ª request do mesmo IP dentro de 1 min
    │
    ▼
ThrottlerGuard.canActivate()
    │ contador > limit
    ▼
CustomThrottlerGuard.throwThrottlingException()
    │
    ├─> rateLimitExceededTotal.add(1)
    │
    └─> throw RateLimitExceededError(retryAfter)
            │
            ▼
        CepExceptionFilter
            │
            ├─> res.setHeader('Retry-After', '42')
            └─> res.status(429).json({ error, message, correlationId })
```

## Testes

E2E em `test/e2e/cep.e2e-spec.ts` (describe `CEP API — rate limit`):

1. Setting `RATE_LIMIT_MAX=3`, faz 3 requests 200 + 1 request 429 com `Retry-After`
2. `/health/live` não é rate-limited (10 requests, todas 200)

Não há teste unit dedicado ao guard — comportamento do `@nestjs/throttler` é responsabilidade da lib. Nosso custom guard só converte a exceção, o que é coberto indiretamente pelo E2E de status 429.

## Ajustando os defaults

Cenários típicos:

| Caso de uso | `RATE_LIMIT_MAX` | `RATE_LIMIT_TTL_MS` |
|---|---|---|
| API interna, cliente único confiável | `300` | `60000` |
| API pública, um cliente por usuário | `60` | `60000` (padrão) |
| API pública, público hostil | `20` | `60000` |
| Debugging local | `10000` | `60000` (efetivamente desligado) |

Rate limit é dial de produção — **deve ser tunado em observação**, não chutado. Inicie com o default e ajuste conforme a taxa real de 429s.

## Decisões NÃO tomadas

- **Single flight / deduplicação**: duas requests pro mesmo CEP simultaneamente ainda fazem 2 chamadas externas. Pertence a [CACHE.md](./CACHE.md), não aqui
- **Rate limit por rota**: uma política global. Se precisar de granularidade (ex: `/cep/:cep` com limite diferente de outras rotas futuras), usar `@Throttle({ default: { ... } })` no método
- **Limite por API key**: projeto não tem auth. Se tivesse, bastaria override do `getTracker` pra retornar a key ao invés do IP
- **Storage distribuído**: ver seção acima
