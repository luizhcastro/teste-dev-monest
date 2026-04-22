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

export interface CachedCepData extends CepData {
  provider: string;
}

export interface CacheLookup {
  data: CachedCepData;
  stale: boolean;
}

@Injectable()
export class CepCacheService {
  private readonly cache: LRUCache<string, CachedCepData>;

  constructor(config: ConfigService<Env, true>) {
    this.cache = new LRUCache<string, CachedCepData>({
      max: config.get('CACHE_MAX_ENTRIES'),        // 10_000
      ttl: config.get('CACHE_TTL_MS'),             // 86_400_000 (24h)
      ttlAutopurge: false,                          // não agendar timers — purge lazy no get
      allowStale: true,
      updateAgeOnGet: false,
      ttlResolution: 60_000,                        // checa TTL no máx a cada 1min
    });
  }

  /**
   * Detalhe sutil do lru-cache v11: com `allowStale: true` no construtor,
   * `cache.get(key)` em entrada expirada retorna o valor stale E **remove a
   * entrada** na mesma chamada. Sem guarda, o ramo `stale: true` nunca
   * dispararia — a primeira leitura devolveria stale como se fosse fresh.
   *
   * `getRemainingTTL`:
   *   > 0  — fresco
   *   < 0  — expirado (mas ainda presente por allowStale)
   *   = 0  — ausente
   */
  get(cep: string): CacheLookup | undefined {
    if (this.cache.getRemainingTTL(cep) > 0) {
      const fresh = this.cache.get(cep);
      if (fresh !== undefined) return { data: fresh, stale: false };
    }

    const stale = this.cache.get(cep, { allowStale: true });
    if (stale !== undefined) return { data: stale, stale: true };

    return undefined;
  }

  set(cep: string, data: CachedCepData): void {
    this.cache.set(cep, data);
  }

  clear(): void { this.cache.clear(); }
  size(): number { return this.cache.size; }
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

### `ttlAutopurge: false`
Com `true`, a lib agenda `setTimeout` pra cada entry expirar — ruim pra 10k CEPs (10k timers pendentes no event loop). Com `false`, a expiração é **lazy**: checada quando o key é acessado ou quando o TTL resolver roda. Combina com `allowStale: true` pra permitir o fallback.

## Chave

CEP normalizado: **só dígitos, 8 chars**. Ex: `01310100`.

Normalização acontece no **pipe** (`CepParamPipe`) **antes** de chegar no service:
```ts
// src/cep/dto/cep-param.dto.ts
export function normalizeCep(raw: string): string {
  return raw.replace(/\D/g, '');
}

@Injectable()
export class CepParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const normalized = normalizeCep(value ?? '');
    if (!/^\d{8}$/.test(normalized)) {
      throw new BadRequestException('CEP inválido: deve ter 8 dígitos');
    }
    return normalized;
  }
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
- `cep_cache_stale_hits_total` (counter) — separado por importância diagnóstica (cada incremento = request que só sobreviveu por causa do stale)

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

`CepCacheService` expõe `clear()` público:

```ts
afterEach(() => {
  cache.clear();
});
```
