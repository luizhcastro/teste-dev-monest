# Fluxo de Requisição

## Diagrama completo

```
GET /cep/:cep
    │
    ▼
┌────────────────────────────┐
│ correlation-id middleware  │  lê X-Correlation-Id ou gera UUID v4
└────────────────────────────┘  anexa em req + response header
    │
    ▼
┌────────────────────────────┐
│ CepParamDto (class-valid.) │  regex /^\d{8}$/ após remover "-"
└────────────────────────────┘  falha → InvalidCepError → [400]
    │
    ▼
┌────────────────────────────┐
│ CepService.lookup(cep)     │
└────────────────────────────┘
    │
    ▼
┌────────────────────────────┐
│ CacheService.get(cep)      │
└────────────────────────────┘
    │
    ├── HIT ───────────────────────────────► return { ...data, cached: true }
    │
    ▼ MISS
┌────────────────────────────┐
│ ProviderSelector.getOrder()│  round-robin: [BrasilAPI, ViaCEP] ou [ViaCEP, BrasilAPI]
└────────────────────────────┘
    │
    ▼
┌────────────────────────────┐
│ for provider in order:     │
│                            │
│   breaker = factory.get(p) │
│                            │
│   if breaker.opened:       │  attempts.push({provider, reason:'circuit_open'})
│       continue             │
│                            │
│   try:                     │
│     data = breaker.fire(   │  timeout 3s via AbortSignal
│       cep, signal)         │
│     cache.set(cep, data)   │
│     return data            │
│                            │
│   except CepNotFoundError: │  ────────► throw (sem fallback, [404] imediato)
│                            │
│   except ProviderError:    │  attempts.push({provider, reason, latencyMs})
│     continue               │
└────────────────────────────┘
    │
    ▼ (todos falharam)
throw AllProvidersUnavailableError(attempts) ──► [503 + Retry-After: 30]
```

## Decisões por tipo de erro

### 404 não dispara fallback — regra de ouro
CEP inexistente é resposta de negócio legítima. Um provider diz "não existe", o outro diria o mesmo. Fallback:
- Gasta latência à toa
- Confunde o circuit breaker (por isso o `errorFilter` ignora `CepNotFoundError`)
- Pode mascarar bugs (se as duas APIs divergem no que consideram "existir")

### 400 é antes de qualquer provider
Validação de formato acontece no DTO do Nest. Zero chamada externa se o input é inválido.

### 503 inclui tentativas detalhadas
```json
{
  "error": "all_providers_unavailable",
  "attempts": [
    { "provider": "brasilapi", "reason": "timeout", "latencyMs": 3001 },
    { "provider": "viacep", "reason": "circuit_open" }
  ],
  "correlationId": "uuid-v4"
}
```
Ajuda cliente a decidir retry. Header `Retry-After: 30` sinaliza quando tentar.

## Casos especiais

### Cache stale quando tudo falha
Com `allowStale: true` no LRU, se ambos providers caírem E houver entrada stale, servimos o stale (marcado `stale: true`) em vez de 503. Dado levemente antigo > erro. Ver [CACHE.md](./CACHE.md).

### Ambos circuitos abertos
Não chamamos ninguém. 503 imediato. Isso **protege as APIs externas** enquanto se recuperam (evita thundering herd quando voltarem).

### Timeout é local, não só do axios
`AbortController` + `setTimeout(3000)` garante que a Promise não fica pendurada mesmo se o axios bugar. `breaker.fire(cep, signal)` passa o signal pro provider.

### Round-robin em baixo tráfego
Com 2 providers e baixo volume, round-robin estrito distribui ~50/50. Se um está com latência alta, o cliente vê latência intermitente. Isso é **intencional** — um provider lento deveria ter o circuito aberto, não ser "evitado silenciosamente".

### Header X-Correlation-Id
Sempre presente na response — sucesso ou erro. Permite ao cliente reportar o ID ao oncall.
