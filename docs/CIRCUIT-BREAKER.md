# Circuit Breaker

Biblioteca: [opossum](https://nodeshift.dev/opossum/).

## Para que serve
Parar de bater em um provider que está falhando consistentemente. Benefícios:
1. **Fail fast**: cliente recebe erro em ms em vez de esperar 3s de timeout
2. **Protege o provider**: ao parar de bater, dá oportunidade de recuperação
3. **Evita thundering herd**: quando provider volta, não é avalanche simultânea

## Estados

```
  ┌──────────┐   threshold de erros    ┌──────────┐
  │  CLOSED  │ ──────────────────────► │   OPEN   │
  │ (normal) │                         │ (skip)   │
  └──────────┘                         └──────────┘
       ▲                                     │
       │                                     │ resetTimeout
       │ sucesso                             ▼
  ┌──────────────┐                    ┌──────────────┐
  │  HALF_OPEN   │ ◄──────────────────┤  HALF_OPEN   │
  │ (1 req teste)│ falha → volta OPEN │              │
  └──────────────┘                    └──────────────┘
```

## Configuração

```ts
new CircuitBreaker(provider.fetch.bind(provider), {
  timeout: 3000,
  errorThresholdPercentage: 50,
  volumeThreshold: 10,
  resetTimeout: 30_000,
  errorFilter: (err) => err instanceof CepNotFoundError,
  name: provider.name,
});
```

### Parâmetros explicados

| Parâmetro | Valor padrão | Por quê |
|---|---|---|
| `timeout` | 3000ms | Combinado com usuário. APIs de CEP deveriam responder em <1s em operação normal |
| `errorThresholdPercentage` | 50 | Metade das req falhando = degradado o suficiente pra parar |
| `volumeThreshold` | 10 | **Crítico em baixo tráfego.** Sem isso, 1 falha em 2 req abre o circuito |
| `resetTimeout` | 30000ms | Tempo antes de tentar HALF_OPEN. 30s cobre blips comuns |
| `errorFilter` | `err instanceof CepNotFoundError` | Retorna `true` → erro **não conta** como falha |
| `name` | `provider.name` | Aparece em logs/métricas |

Todos vêm de env vars (ver [SETUP.md](./SETUP.md)) — permite tuning sem redeploy.

## `errorFilter` é **crítico**

Sem ele, cada 404 (CEP inexistente) conta como falha. Resultado: um usuário digitando CEPs errados abre o circuito. Absurdo.

`errorFilter` recebe o erro e retorna `true` se o erro **deve ser ignorado** pelo breaker. A convenção do opossum é inversa do intuitivo — teste isso.

## Um breaker **por provider**, não global

Se ViaCEP está fora mas BrasilAPI está bem, breaker global derrubaria ambos. Por provider:
- ViaCEP com circuito OPEN → pula, vai pro BrasilAPI
- BrasilAPI continua servindo normalmente

## Factory

```ts
@Injectable()
export class CircuitBreakerFactory implements OnModuleDestroy {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly config: ConfigService) {}

  get(provider: CepProvider): CircuitBreaker {
    const existing = this.breakers.get(provider.name);
    if (existing) return existing;

    const breaker = new CircuitBreaker(
      (cep: string, signal: AbortSignal) => provider.fetch(cep, signal),
      {
        timeout: this.config.get('PROVIDER_TIMEOUT_MS'),
        errorThresholdPercentage: this.config.get('CIRCUIT_ERROR_THRESHOLD_PERCENTAGE'),
        volumeThreshold: this.config.get('CIRCUIT_VOLUME_THRESHOLD'),
        resetTimeout: this.config.get('CIRCUIT_RESET_TIMEOUT_MS'),
        errorFilter: (err) => err instanceof CepNotFoundError,
        name: provider.name,
      },
    );

    this.attachTelemetry(breaker, provider.name);
    this.breakers.set(provider.name, breaker);
    return breaker;
  }

  private attachTelemetry(breaker: CircuitBreaker, name: string) {
    breaker.on('open', () => {
      logger.warn({ provider: name }, 'circuit opened');
      circuitStateMetric.record(2, { provider: name });
    });
    breaker.on('halfOpen', () => {
      logger.info({ provider: name }, 'circuit half-open');
      circuitStateMetric.record(1, { provider: name });
    });
    breaker.on('close', () => {
      logger.info({ provider: name }, 'circuit closed');
      circuitStateMetric.record(0, { provider: name });
    });
    breaker.on('reject', () => {
      circuitRejectionsCounter.add(1, { provider: name });
    });
  }

  onModuleDestroy() {
    for (const b of this.breakers.values()) b.shutdown();
  }
}
```

## Uso no service

```ts
const attempts: ProviderAttempt[] = [];

for (const provider of this.selector.getOrder()) {
  const breaker = this.breakerFactory.get(provider);

  if (breaker.opened) {
    attempts.push({ provider: provider.name, reason: 'circuit_open' });
    continue;
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const data = await breaker.fire(cep, controller.signal);
    await this.cache.set(cep, { ...data, provider: provider.name });
    return { ...data, provider: provider.name, cached: false };
  } catch (err) {
    if (err instanceof CepNotFoundError) throw err;       // 404 imediato

    const reason = this.mapErrorToReason(err);
    attempts.push({
      provider: provider.name,
      reason,
      latencyMs: Date.now() - start,
    });
  }
}

throw new AllProvidersUnavailableError(attempts);
```

## Estado compartilhado entre instâncias?

**Não.** Breaker é local ao processo. Em k8s com N réplicas, cada uma tem seu próprio estado. Tudo bem — cada réplica protege seu próprio pool.

Distribuído (Redis) seria overkill: (a) complica e (b) se uma réplica está enxergando falhas e a outra não, **elas estão enxergando coisas diferentes**, e faz sentido decidirem independentemente.

## Edge cases

### Circuito fecha enquanto iteramos
Possível? Sim. Solução: `breaker.opened` é lido uma vez por iteração do loop. Se fechou depois, a próxima request pega o estado novo. Não há correção elegante pra isso e não importa — é uma janela de ms.

### Dois circuitos abrem ao mesmo tempo
`AllProvidersUnavailableError` com ambos attempts marcados `circuit_open`. Cache stale (se existir) pode salvar via `allowStale`. Ver [CACHE.md](./CACHE.md).

### `breaker.fire` com timeout do opossum vs AbortSignal
O opossum tem timeout próprio (`timeout: 3000`). Passamos `AbortSignal` **mesmo assim** pro provider cancelar a chamada HTTP quando o timeout dispara. Sem isso, o opossum rejeita a Promise mas a conexão fica aberta.

## Testes
Circuit breaker real é difícil de testar por causa de timing. Prefira:
- **Service com breaker mockado** (`{ opened: true, fire: jest.fn() }`) — testa lógica do service
- **Teste dedicado do factory** — garante que parâmetros vão certos pro opossum
- Deixe testes de comportamento do breaker pra biblioteca (já é testada)
