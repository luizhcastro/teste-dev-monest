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
  const url = `${this.baseUrl}/ws/${cep}/json/`;

  let response: Response;
  try {
    response = await globalThis.fetch(url, { signal });
  } catch (err) {
    throw mapFetchError(this.name, err); // AbortError → Timeout, resto → Network
  }

  if (!response.ok) throw new ProviderHttpError(this.name, response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ProviderContractError(this.name, err);
  }

  const parsed = viaCepSchema.safeParse(body);
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
  const url = `${this.baseUrl}/api/cep/v1/${cep}`;

  let response: Response;
  try {
    response = await globalThis.fetch(url, { signal });
  } catch (err) {
    throw mapFetchError(this.name, err);
  }

  if (response.status === 404) throw new CepNotFoundError(cep);
  if (!response.ok) throw new ProviderHttpError(this.name, response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new ProviderContractError(this.name, err);
  }

  const parsed = brasilApiSchema.safeParse(body);
  if (!parsed.success) throw new ProviderContractError(this.name, parsed.error);

  return { cep, ...parsed.data };
}
```

### `fetch-error.mapper.ts`
Centraliza a conversão de erros do `fetch` em `ProviderError`:

```ts
export function mapFetchError(provider: string, err: unknown): ProviderError {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new ProviderTimeoutError(provider, err);
  }
  return new ProviderNetworkError(provider, err);
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
// viacep.schema.ts — union entre sucesso e erro
export const viaCepSuccessSchema = z.object({
  cep: z.string(),
  logradouro: z.string(),
  bairro: z.string(),
  localidade: z.string(),
  uf: z.string().length(2),
});

// ViaCEP já retornou tanto `{erro: true}` quanto `{erro: "true"}` em momentos
// diferentes. Aceitar ambos evita `ProviderContractError` espúrio.
export const viaCepErrorSchema = z.object({
  erro: z.union([z.literal(true), z.literal('true')]),
});

export const viaCepSchema = z.union([viaCepSuccessSchema, viaCepErrorSchema]);

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

1. Criar `src/cep/providers/postmon.provider.ts` implementando `CepProvider` (usando `globalThis.fetch` + `mapFetchError`)
2. Criar `src/cep/schemas/postmon.schema.ts` com Zod
3. Registrar no `CepModule` — adicionar como classe e incluir na factory do `CEP_PROVIDERS`:
   ```ts
   providers: [
     ViaCepProvider,
     BrasilApiProvider,
     PostmonProvider,
     {
       provide: CEP_PROVIDERS,
       useFactory: (via, br, postmon) => [via, br, postmon],
       inject: [ViaCepProvider, BrasilApiProvider, PostmonProvider],
     },
   ]
   ```
4. O `CircuitBreakerFactory` detecta automaticamente (cria breaker no primeiro uso)
5. Adicionar env var `POSTMON_URL` no Zod env schema (se quiser configurável)

**Zero mudança em:** controller, service, selector, exception filter, cache.

**Testes necessários:** integration do novo provider (com `jest.spyOn(globalThis, 'fetch')`), adicionar cenário no teste de round-robin com 3+ providers (já existe no `provider-selector.service.spec.ts`).
