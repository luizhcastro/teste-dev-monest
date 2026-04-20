# Cache

## Decisão: LRU em memória (não Redis)

### Por que LRU in-process
- CEP é **praticamente imutável** (raríssimo endereço mudar)
- 10k CEPs em cache = poucos MB em memória
- Zero infra extra, zero latência de rede
- Suficiente pro escopo do teste
- Cada instância independente → sem overhead de coordenação

### Quando migraria pra Redis
- Chamada externa tem custo relevante (ex: API paga)
- Precisar invalidar cache coordenado entre réplicas
- Rodar em serverless onde processo não persiste
- Volume de CEPs distintos ultrapassando memória confortável

Para o desafio, **LRU vence por simplicidade**.

## Config

```ts
// src/cep/cache/cep-cache.service.ts
import { LRUCache } from 'lru-cache';

@Injectable()
export class CepCacheService {
  private readonly cache: LRUCache<string, CachedCepData>;

  constructor(config: ConfigService) {
    this.cache = new LRUCache({
      max: config.get('CACHE_MAX_ENTRIES'),        // 10_000
      ttl: config.get('CACHE_TTL_MS'),             // 86_400_000 (24h)
      allowStale: true,
      updateAgeOnGet: false,
      ttlResolution: 60_000,                       // verifica TTL a cada 1min
    });
  }

  get(cep: string): { data: CachedCepData; stale: boolean } | undefined {
    const fresh = this.cache.get(cep);
    if (fresh) return { data: fresh, stale: false };

    const stale = this.cache.get(cep, { allowStale: true });
    if (stale) return { data: stale, stale: true };

    return undefined;
  }

  set(cep: string, data: CachedCepData): void {
    this.cache.set(cep, data);
  }

  size(): number {
    return this.cache.size;
  }
}

interface CachedCepData extends CepData {
  provider: string;
}
```

### Por que `allowStale: true`?
**Se ambos providers caem, servir cache stale > retornar 503.** Tradeoff: dado levemente antigo é aceitável pra CEP (semanticamente imutável).

Implementação no service:
```ts
const cached = this.cache.get(cep);
if (cached && !cached.stale) {
  return { ...cached.data, cached: true };
}

// tenta providers
try {
  return await this.tryProviders(cep);
} catch (err) {
  if (err instanceof AllProvidersUnavailableError && cached?.stale) {
    return { ...cached.data, cached: true, stale: true };
  }
  throw err;
}
```

### Por que `updateAgeOnGet: false`?
Queremos TTL desde quando o dado foi **buscado**, não desde o último acesso. Se um CEP popular continuasse "novo" por 24h sempre que acessado, nunca expiraria e acumularia divergência silenciosa.

### `ttlResolution`
Evita checar TTL em cada `.get()`. 1 minuto de granularidade é ok — pior caso, serve dado 1min expirado (aceitável).

## Chave

CEP normalizado: **só dígitos, 8 chars**. Ex: `01310100`.

Normalização acontece no DTO **antes** de chegar no service:
```ts
export class CepParamDto {
  @Transform(({ value }) => value.replace(/\D/g, ''))
  @Matches(/^\d{8}$/)
  cep: string;
}
```

Input `01310-100`, `01310100`, `01 310 100` → todos viram `01310100` → cache compartilha.

## O que NÃO cachear

- **404s (CEP não existe)**: alguém digitou errado, logo vem o correto. Cachear 404 economiza pouco e mantém negativo stale
- **Erros de provider** (óbvio)

## Observabilidade

### Métricas
- `cep_cache_hits_total` (counter)
- `cep_cache_misses_total` (counter)
- `cep_cache_size` (gauge, observado em scrape)
- `cep_cache_stale_hits_total` (counter) — separado por importância diagnóstica

### Logs
- INFO em cache hit com `{ cep, cached: true, stale: false|true }`
- Span OTel da request tem `cep.cached` e `cep.stale` como atributos

### Alvo
Hit rate >80% após warm-up em produção. Em teste local, varia conforme diversidade de CEPs testados.

## Cache miss e race condition

Dois requests simultâneos pro mesmo CEP fazem duas chamadas externas. Poderia ter **single-flight** (Promise.any compartilhada) mas:
- Complexidade extra
- Para CEP (latência curta, APIs gratuitas), impacto é baixo
- **Não vale o custo**

Fica como "possível melhoria" documentada.

## Reset em testes

```ts
it('resetta entre testes', () => {
  cache['cache'].clear();
});
```

Ou expor `clear()` público e chamar em `afterEach`.
