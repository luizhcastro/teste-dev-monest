# Providers

## Interface

```ts
// src/cep/providers/cep-provider.interface.ts
export const CEP_PROVIDERS = Symbol('CEP_PROVIDERS');

export interface CepProvider {
  readonly name: string;                    // 'viacep' | 'brasilapi' | ...
  fetch(cep: string, signal: AbortSignal): Promise<CepData>;
}

export interface CepData {
  cep: string;                              // 8 dígitos, sem hífen
  street: string;
  neighborhood: string;
  city: string;
  state: string;
}
```

## Contrato de implementação

- `fetch` recebe **CEP já normalizado** (8 dígitos) e um `AbortSignal` pro timeout
- Retorna `CepData` com campos normalizados (nomes consistentes entre providers)
- Lança `CepNotFoundError` se o provider indicar que CEP não existe
- Lança `ProviderHttpError`, `ProviderTimeoutError`, `ProviderNetworkError` ou `ProviderContractError` pros outros casos
- Provider **não implementa** retry, circuit ou cache — isso é responsabilidade do service/factory

## ViaCepProvider

- **URL**: `https://viacep.com.br/ws/{cep}/json/`
- **Quirk**: "não encontrado" é `HTTP 200` com payload `{ erro: true }` (sim, 200 com erro no body)
- **Mapeamento**:
  | ViaCEP | CepData |
  |---|---|
  | `logradouro` | `street` |
  | `bairro` | `neighborhood` |
  | `localidade` | `city` |
  | `uf` | `state` |

```ts
async fetch(cep: string, signal: AbortSignal): Promise<CepData> {
  const response = await axios.get(`${this.baseUrl}/ws/${cep}/json/`, { signal });
  const parsed = viaCepSchema.safeParse(response.data);
  if (!parsed.success) throw new ProviderContractError(this.name, parsed.error);
  if ('erro' in parsed.data) throw new CepNotFoundError(cep);
  return {
    cep,
    street: parsed.data.logradouro,
    neighborhood: parsed.data.bairro,
    city: parsed.data.localidade,
    state: parsed.data.uf,
  };
}
```

## BrasilApiProvider

- **URL**: `https://brasilapi.com.br/api/cep/v1/{cep}`
- **"Não encontrado"**: HTTP 404 (comportamento idiomático)
- **Mapeamento**: campos já casam com `CepData` (`street`, `neighborhood`, `city`, `state`)

```ts
async fetch(cep: string, signal: AbortSignal): Promise<CepData> {
  try {
    const response = await axios.get(`${this.baseUrl}/api/cep/v1/${cep}`, { signal });
    const parsed = brasilApiSchema.safeParse(response.data);
    if (!parsed.success) throw new ProviderContractError(this.name, parsed.error);
    return { cep, ...parsed.data };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      throw new CepNotFoundError(cep);
    }
    throw this.mapAxiosError(err);
  }
}
```

## Round-robin: ProviderSelectorService

```ts
@Injectable()
export class ProviderSelectorService {
  private counter = 0;

  constructor(
    @Inject(CEP_PROVIDERS) private readonly providers: CepProvider[],
  ) {}

  getOrder(): CepProvider[] {
    const start = this.counter++ % this.providers.length;
    return [
      ...this.providers.slice(start),
      ...this.providers.slice(0, start),
    ];
  }
}
```

- Counter incrementa **por chamada** (não só por sucesso) — distribuição uniforme
- Retorna array rotacionado; fallback segue a ordem
- Multi-instância: cada processo tem seu próprio counter (tudo bem — distribuição probabilística é equivalente)

## Validação Zod nas respostas

Cada provider tem schema em `src/cep/schemas/`:

```ts
// viacep.schema.ts
export const viaCepSchema = z.union([
  z.object({
    cep: z.string(),
    logradouro: z.string(),
    bairro: z.string(),
    localidade: z.string(),
    uf: z.string().length(2),
  }),
  z.object({ erro: z.literal(true) }),
]);

// brasilapi.schema.ts
export const brasilApiSchema = z.object({
  cep: z.string(),
  street: z.string(),
  neighborhood: z.string(),
  city: z.string(),
  state: z.string().length(2),
});
```

**Por que:** APIs externas mudam contrato. Sem validação, dado corrompido vaza pro cliente silenciosamente. Com validação, vira `ProviderContractError` → fallback → alerta em métrica.

## Como adicionar um novo provider (ex: Postmon)

1. Criar `src/cep/providers/postmon.provider.ts` implementando `CepProvider`
2. Criar `src/cep/schemas/postmon.schema.ts` com Zod
3. Registrar no `CepModule`:
   ```ts
   { provide: CEP_PROVIDERS, useClass: PostmonProvider, multi: true }
   ```
4. O `CircuitBreakerFactory` detecta automaticamente (cria breaker no primeiro uso)
5. Adicionar env var `POSTMON_URL` (se quiser configurável)

**Zero mudança em:** controller, service, selector, exception filter, cache.

**Testes necessários:** unit do parsing, integration com nock, adicionar cenário no teste de round-robin com 3+ providers.
