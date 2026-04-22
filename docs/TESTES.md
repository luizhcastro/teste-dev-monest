# Estratégia de Testes

## Filosofia
README diz: *"não avaliamos cobertura de 100%"*. Então: **teste o design, não linhas**. Cada teste prova que uma decisão arquitetural funciona.

## Pirâmide

```
         ╱╲
        ╱  ╲     E2E (2-3 testes)
       ╱────╲    Golden paths via HTTP
      ╱      ╲
     ╱────────╲  Integration (por provider)
    ╱          ╲ Com jest.spyOn(globalThis, 'fetch')
   ╱────────────╲
  ╱              ╲ Unit (service, selector, cache, errors)
 ╱________________╲
```

## Cenários críticos (obrigatórios)

1. **Service: fallback funciona** — primeiro timeout, segundo responde
2. **Service: 404 NÃO dispara fallback** — é a regra de ouro
3. **Service: todos falham → 503 com attempts**
4. **Service: cache hit não chama provider**
5. **Service: todos falharam mas tem stale → serve stale**
6. **Selector: round-robin rotaciona** — chamadas consecutivas têm ordens diferentes
7. **Circuit: pula provider com `breaker.opened`**
8. **Providers: parsing correto (ViaCEP e BrasilAPI)**
9. **Providers: `{erro:true}` → CepNotFoundError (ViaCEP)**
10. **Providers: 404 → CepNotFoundError (BrasilAPI)**
11. **Providers: contrato quebrado → ProviderContractError (via Zod)**
12. **Providers: timeout aborta request**
13. **Exception filter: mapeia erros pros status corretos**
14. **DTO: normalização de CEP (remove hífen, aceita só dígitos)**
15. **E2E: GET /cep/:cep golden path**
16. **E2E: GET /cep/abc → 400**
17. **E2E: rate limit → 429 + Retry-After** (`RATE_LIMIT_MAX=3`; `/health/live` não é rate-limited)
18. **E2E: stale cache fallback** — TTL expira, providers caem, retorna 200 com `cached: true`
19. **E2E: propaga `X-Correlation-Id` do request pro response**
20. **CacheService: distingue fresh vs stale** — guard com `getRemainingTTL` evita drift do `allowStale`
21. **CircuitBreakerFactory: cria breaker por provider, reutiliza, shutdown em `onModuleDestroy`**

## Ferramentas

| Ferramenta | Uso |
|---|---|
| **Jest** | Test runner (padrão do Nest) |
| **`jest.spyOn(globalThis, 'fetch')`** | Intercepta HTTP externo dos providers — sem lib extra, usa a Fetch API nativa |
| **supertest** | E2E do endpoint |
| `@nestjs/testing` | Monta módulo de teste com DI |

**Por que não `nock`?** Como o código usa `fetch` nativo (não axios + http adapter), `jest.spyOn` no `globalThis.fetch` mock é mais direto e não carrega dependência extra. Retornamos `new Response(JSON.stringify(body), { status, headers })` — mesma API que o runtime usa.

## Estrutura

```
test/
  fixtures/
    mock-cep-data.ts
  unit/
    cep.service.spec.ts
    cep-cache.service.spec.ts
    circuit-breaker.factory.spec.ts
    provider-selector.service.spec.ts
    cep-param.pipe.spec.ts
    health.controller.spec.ts
  integration/
    viacep.provider.spec.ts       # jest.spyOn(globalThis, 'fetch')
    brasilapi.provider.spec.ts    # jest.spyOn(globalThis, 'fetch')
  e2e/
    cep.e2e-spec.ts               # fetch mock + supertest (inclui rate limit + stale cache fallback)
  jest-e2e.json
```

**Total atual:** 40 unit + 10 integration + 15 e2e = **65 testes** verdes.

## CepService (o mais importante)

```ts
describe('CepService', () => {
  let service: CepService;
  let providerA: jest.Mocked<CepProvider>;
  let providerB: jest.Mocked<CepProvider>;
  let breakerFactory: jest.Mocked<CircuitBreakerFactory>;
  let cache: jest.Mocked<CepCacheService>;

  beforeEach(async () => {
    providerA = { name: 'A', fetch: jest.fn() };
    providerB = { name: 'B', fetch: jest.fn() };

    // breaker mock simples que chama fetch diretamente
    const mockBreaker = (p: CepProvider) => ({
      opened: false,
      fire: (cep: string, signal: AbortSignal) => p.fetch(cep, signal),
    });

    breakerFactory = { get: jest.fn((p) => mockBreaker(p) as any) } as any;
    cache = { get: jest.fn(), set: jest.fn() } as any;

    const module = await Test.createTestingModule({
      providers: [
        CepService,
        { provide: CircuitBreakerFactory, useValue: breakerFactory },
        { provide: CepCacheService, useValue: cache },
        { provide: ProviderSelectorService, useValue: {
          getOrder: () => [providerA, providerB],
        }},
      ],
    }).compile();

    service = module.get(CepService);
  });

  it('returns success from first provider', async () => {
    providerA.fetch.mockResolvedValue(mockCepData);
    const result = await service.lookup('01310100');
    expect(result.provider).toBe('A');
    expect(providerB.fetch).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();
  });

  it('falls back when first times out', async () => {
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockResolvedValue(mockCepData);
    const result = await service.lookup('01310100');
    expect(result.provider).toBe('B');
  });

  it('404 on first does NOT try second', async () => {
    providerA.fetch.mockRejectedValue(new CepNotFoundError('00000000'));
    await expect(service.lookup('00000000'))
      .rejects.toBeInstanceOf(CepNotFoundError);
    expect(providerB.fetch).not.toHaveBeenCalled();
  });

  it('all fail → AllProvidersUnavailableError with attempts', async () => {
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockRejectedValue(new ProviderHttpError('B', 502));

    await expect(service.lookup('01310100')).rejects.toMatchObject({
      status: 503,
      code: 'all_providers_unavailable',
      attempts: [
        expect.objectContaining({ provider: 'A', reason: 'timeout' }),
        expect.objectContaining({ provider: 'B', reason: 'http_error' }),
      ],
    });
  });

  it('cache hit does not call provider', async () => {
    cache.get.mockReturnValue({ data: mockCachedData, stale: false });
    const result = await service.lookup('01310100');
    expect(result.cached).toBe(true);
    expect(providerA.fetch).not.toHaveBeenCalled();
  });

  it('all fail but stale exists → serves stale', async () => {
    cache.get.mockReturnValue({ data: mockCachedData, stale: true });
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockRejectedValue(new ProviderTimeoutError('B'));

    const result = await service.lookup('01310100');
    expect(result.cached).toBe(true);
  });

  it('skips provider with open circuit', async () => {
    breakerFactory.get.mockImplementation((p) => ({
      opened: p.name === 'A',
      fire: (cep, sig) => p.fetch(cep, sig),
    } as any));

    providerB.fetch.mockResolvedValue(mockCepData);

    const result = await service.lookup('01310100');
    expect(providerA.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('B');
  });
});
```

## ProviderSelectorService

```ts
describe('ProviderSelectorService', () => {
  it('rotates order on each call', () => {
    const p1 = { name: 'A' } as CepProvider;
    const p2 = { name: 'B' } as CepProvider;
    const selector = new ProviderSelectorService([p1, p2]);

    const order1 = selector.getOrder();
    const order2 = selector.getOrder();

    expect(order1[0].name).not.toBe(order2[0].name);
    expect(order1).toHaveLength(2);
  });
});
```

## ViaCepProvider (integration com fetch mock)

```ts
function mockFetch(impl: typeof fetch) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(impl as never);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ViaCepProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses success response and normalizes fields', async () => {
    mockFetch(async () =>
      jsonResponse(200, {
        cep: '01310-100',
        logradouro: 'Avenida Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
      }),
    );

    const provider = makeProvider();
    const data = await provider.fetch('01310100', new AbortController().signal);

    expect(data).toEqual({
      cep: '01310100',
      street: 'Avenida Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
  });

  it('{erro:true} → CepNotFoundError', async () => {
    mockFetch(async () => jsonResponse(200, { erro: true }));
    await expect(
      makeProvider().fetch('00000000', new AbortController().signal),
    ).rejects.toBeInstanceOf(CepNotFoundError);
  });

  it('unexpected contract → ProviderContractError', async () => {
    mockFetch(async () => jsonResponse(200, { inesperado: 'payload' }));
    await expect(
      makeProvider().fetch('01310100', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('5xx → ProviderHttpError', async () => {
    mockFetch(async () => new Response('', { status: 503 }));
    await expect(
      makeProvider().fetch('01310100', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('AbortSignal abort → ProviderTimeoutError', async () => {
    mockFetch(async (_url, init) => {
      const signal = (init as RequestInit).signal!;
      return new Promise<Response>((_r, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    });

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    await expect(
      makeProvider().fetch('01310100', ctrl.signal),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});
```

## E2E

```ts
describe('GET /cep/:cep (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  afterEach(() => jest.restoreAllMocks());

  it('golden path', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('brasilapi.com.br')) {
        return jsonResponse(200, mockBrasilApiResponse);
      }
      return jsonResponse(500, {});
    });

    const res = await request(app.getHttpServer()).get('/cep/01310100');

    expect(res.status).toBe(200);
    expect(res.body.street).toBeDefined();
    expect(res.body.provider).toBeDefined();
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('invalid format → 400', async () => {
    const res = await request(app.getHttpServer()).get('/cep/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cep');
  });

  it('normalizes hyphen', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, mockBrasilApiResponse),
    );
    const res = await request(app.getHttpServer()).get('/cep/01310-100');
    expect(res.status).toBe(200);
  });

  it('all providers down → 503 with attempts', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 }),
    );

    const res = await request(app.getHttpServer()).get('/cep/01310100');

    expect(res.status).toBe(503);
    expect(res.body.attempts).toHaveLength(2);
    expect(res.headers['retry-after']).toBe('30');
  });
});
```

### Health E2E

```ts
it('GET /health/live → 200', async () => {
  const res = await request(app.getHttpServer()).get('/health/live');
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
});

it('GET /health/ready → 200 with closed circuits', async () => {
  const res = await request(app.getHttpServer()).get('/health/ready');
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ready');
});
```

## O que NÃO testar

- **Bibliotecas** (opossum, lru-cache, zod, pino) — confia
- **Nest internals** (DI, middleware wiring)
- **OTel** — basta testar que chamamos as APIs certas; comportamento é da biblioteca
- **Circuit breaker real** — timing é instável; mock é mais confiável

## Coverage

Rodar, mas **não perseguir número**. Bom piso: 70% de statements, 80% dos branches dos componentes críticos (service, providers, errors, filter).

```bash
npm test -- --coverage
```

## Mocks compartilhados

`test/fixtures/mock-cep-data.ts`:
```ts
export const mockCepData: CepData = {
  cep: '01310100',
  street: 'Avenida Paulista',
  neighborhood: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
};

export const mockViaCepResponse = { /* ... */ };
export const mockBrasilApiResponse = { /* ... */ };
```
