# Estratégia de Testes

## Filosofia
README diz: *"não avaliamos cobertura de 100%"*. Então: **teste o design, não linhas**. Cada teste prova que uma decisão arquitetural funciona.

## Pirâmide

```
         ╱╲
        ╱  ╲     E2E (2-3 testes)
       ╱────╲    Golden paths via HTTP
      ╱      ╲
     ╱────────╲  Integration (por provider + module)
    ╱          ╲ Com nock mockando HTTP externo
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

## Ferramentas

| Ferramenta | Uso |
|---|---|
| **Jest** | Test runner (padrão do Nest) |
| **nock** | Intercepta HTTP externo (providers) |
| **supertest** | E2E do endpoint |
| `@nestjs/testing` | Monta módulo de teste com DI |

## Estrutura

```
test/
  unit/
    cep.service.spec.ts
    provider-selector.service.spec.ts
    cep-cache.service.spec.ts
    cep.errors.spec.ts
    cep-exception.filter.spec.ts
    cep-param.dto.spec.ts
  integration/
    viacep.provider.spec.ts       # com nock
    brasilapi.provider.spec.ts    # com nock
  e2e/
    cep.e2e-spec.ts               # com nock + supertest
```

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

  it('retorna sucesso no primeiro provider', async () => {
    providerA.fetch.mockResolvedValue(mockCepData);
    const result = await service.lookup('01310100');
    expect(result.provider).toBe('A');
    expect(providerB.fetch).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();
  });

  it('faz fallback quando primeiro timeout', async () => {
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockResolvedValue(mockCepData);
    const result = await service.lookup('01310100');
    expect(result.provider).toBe('B');
  });

  it('404 no primeiro NÃO tenta o segundo', async () => {
    providerA.fetch.mockRejectedValue(new CepNotFoundError('00000000'));
    await expect(service.lookup('00000000'))
      .rejects.toBeInstanceOf(CepNotFoundError);
    expect(providerB.fetch).not.toHaveBeenCalled();
  });

  it('todos falham → AllProvidersUnavailableError com attempts', async () => {
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

  it('cache hit não chama provider', async () => {
    cache.get.mockReturnValue({ data: mockCachedData, stale: false });
    const result = await service.lookup('01310100');
    expect(result.cached).toBe(true);
    expect(providerA.fetch).not.toHaveBeenCalled();
  });

  it('todos falham mas tem stale → serve stale', async () => {
    cache.get.mockReturnValue({ data: mockCachedData, stale: true });
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockRejectedValue(new ProviderTimeoutError('B'));

    const result = await service.lookup('01310100');
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(true);
  });

  it('pula provider com circuito aberto', async () => {
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
  it('rotaciona a ordem a cada chamada', () => {
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

## ViaCepProvider (integration com nock)

```ts
describe('ViaCepProvider', () => {
  let provider: ViaCepProvider;

  beforeEach(() => {
    provider = new ViaCepProvider({ baseUrl: 'https://viacep.com.br' });
  });

  afterEach(() => nock.cleanAll());

  it('parseia resposta com sucesso', async () => {
    nock('https://viacep.com.br')
      .get('/ws/01310100/json/')
      .reply(200, {
        cep: '01310-100',
        logradouro: 'Av Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
      });

    const data = await provider.fetch('01310100', new AbortController().signal);

    expect(data).toEqual({
      cep: '01310100',
      street: 'Av Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
  });

  it('`{erro:true}` → CepNotFoundError', async () => {
    nock('https://viacep.com.br')
      .get('/ws/00000000/json/')
      .reply(200, { erro: true });

    await expect(provider.fetch('00000000', new AbortController().signal))
      .rejects.toBeInstanceOf(CepNotFoundError);
  });

  it('contrato quebrado → ProviderContractError', async () => {
    nock('https://viacep.com.br')
      .get('/ws/01310100/json/')
      .reply(200, { unexpected: 'payload' });

    await expect(provider.fetch('01310100', new AbortController().signal))
      .rejects.toBeInstanceOf(ProviderContractError);
  });

  it('timeout via AbortSignal', async () => {
    nock('https://viacep.com.br')
      .get('/ws/01310100/json/')
      .delay(5000)
      .reply(200, {});

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);

    await expect(provider.fetch('01310100', ctrl.signal))
      .rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('5xx → ProviderHttpError', async () => {
    nock('https://viacep.com.br')
      .get('/ws/01310100/json/')
      .reply(503);

    await expect(provider.fetch('01310100', new AbortController().signal))
      .rejects.toBeInstanceOf(ProviderHttpError);
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
  afterEach(() => nock.cleanAll());

  it('golden path', async () => {
    nock('https://brasilapi.com.br')
      .get('/api/cep/v1/01310100')
      .reply(200, mockBrasilApiResponse);

    const res = await request(app.getHttpServer()).get('/cep/01310100');

    expect(res.status).toBe(200);
    expect(res.body.street).toBeDefined();
    expect(res.body.provider).toBeDefined();
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('formato inválido → 400', async () => {
    const res = await request(app.getHttpServer()).get('/cep/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cep');
  });

  it('normaliza hífen', async () => {
    nock('https://brasilapi.com.br')
      .get('/api/cep/v1/01310100')
      .reply(200, mockBrasilApiResponse);

    const res = await request(app.getHttpServer()).get('/cep/01310-100');
    expect(res.status).toBe(200);
  });

  it('todos caem → 503 com attempts', async () => {
    nock('https://brasilapi.com.br').get(/.*/).reply(503);
    nock('https://viacep.com.br').get(/.*/).reply(503);

    const res = await request(app.getHttpServer()).get('/cep/01310100');

    expect(res.status).toBe(503);
    expect(res.body.attempts).toHaveLength(2);
    expect(res.headers['retry-after']).toBe('30');
  });
});
```

## O que NÃO testar

- **Bibliotecas** (opossum, axios, lru-cache, zod) — confia
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
