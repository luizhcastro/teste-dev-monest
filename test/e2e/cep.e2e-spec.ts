import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CepExceptionFilter } from '../../src/common/filters/cep-exception.filter';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchImpl(impl: typeof fetch): jest.SpyInstance {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(impl as never) as jest.SpyInstance;
}

describe('CEP API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new CepExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET /cep/:cep → 200 with normalized data (golden path)', async () => {
    mockFetchImpl(async (url) => {
      const u = String(url);
      if (u.includes('viacep')) {
        return jsonResponse(200, {
          cep: '01310-100',
          logradouro: 'Avenida Paulista',
          bairro: 'Bela Vista',
          localidade: 'São Paulo',
          uf: 'SP',
        });
      }
      return jsonResponse(500, {});
    });

    const res = await request(app.getHttpServer()).get('/cep/01310100');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cep: '01310100',
      street: 'Avenida Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
      cached: false,
    });
    expect(typeof res.body.provider).toBe('string');
  });

  it('GET /cep/:cep accepts CEP with hyphen', async () => {
    mockFetchImpl(async () =>
      jsonResponse(200, {
        cep: '01310-100',
        logradouro: 'Avenida Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
      }),
    );

    const res = await request(app.getHttpServer()).get('/cep/01310-100');

    expect(res.status).toBe(200);
    expect(res.body.cep).toBe('01310100');
  });

  it('GET /cep/abc → 400 invalid_cep', async () => {
    const res = await request(app.getHttpServer()).get('/cep/abc');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'invalid_cep',
    });
    expect(res.body.correlationId).toBeDefined();
  });

  it('GET /cep/12345 → 400 invalid_cep (less than 8 digits)', async () => {
    const res = await request(app.getHttpServer()).get('/cep/12345');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cep');
  });

  it('GET /cep/:cep not found → 404', async () => {
    mockFetchImpl(async (url) => {
      const u = String(url);
      if (u.includes('viacep')) {
        return jsonResponse(200, { erro: true });
      }
      return jsonResponse(404, {});
    });

    const res = await request(app.getHttpServer()).get('/cep/99999999');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: 'cep_not_found',
    });
    expect(res.body.correlationId).toBeDefined();
  });

  it('GET /cep/:cep all providers 5xx → 503 with attempts', async () => {
    mockFetchImpl(async () => new Response('', { status: 503 }));

    const res = await request(app.getHttpServer()).get('/cep/02040030');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'all_providers_unavailable',
    });
    expect(res.body.attempts).toBeInstanceOf(Array);
    expect(res.body.attempts.length).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('GET /health/live → 200 { status: ok }', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready → 200 ready (no breakers yet)', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(Array.isArray(res.body.circuits)).toBe(true);
  });

  it('propagates X-Correlation-Id from request to response', async () => {
    mockFetchImpl(async () =>
      jsonResponse(200, {
        cep: '01310-100',
        logradouro: 'Avenida Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
      }),
    );

    const cid = 'test-correlation-abc-123';
    const res = await request(app.getHttpServer())
      .get('/cep/01310100')
      .set('X-Correlation-Id', cid);

    expect(res.status).toBe(200);
    const headerValue =
      res.headers['x-correlation-id'] ?? res.headers['X-Correlation-Id'];
    expect(headerValue).toBe(cid);
  });
});

describe('CEP API — rate limit (e2e)', () => {
  let app: INestApplication;
  const originalTtl = process.env.RATE_LIMIT_TTL_MS;
  const originalMax = process.env.RATE_LIMIT_MAX;

  beforeAll(async () => {
    process.env.RATE_LIMIT_TTL_MS = '60000';
    process.env.RATE_LIMIT_MAX = '3';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new CepExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (originalTtl === undefined) delete process.env.RATE_LIMIT_TTL_MS;
    else process.env.RATE_LIMIT_TTL_MS = originalTtl;
    if (originalMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = originalMax;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bloqueia requests acima do limite com 429 + Retry-After', async () => {
    mockFetchImpl(async () =>
      jsonResponse(200, {
        cep: '01310-100',
        logradouro: 'Avenida Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
      }),
    );

    const server = app.getHttpServer();

    for (let i = 0; i < 3; i++) {
      const ok = await request(server).get('/cep/01310100');
      expect(ok.status).toBe(200);
    }

    const blocked = await request(server).get('/cep/01310100');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      error: 'rate_limit_exceeded',
    });
    expect(blocked.body.correlationId).toBeDefined();
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('não aplica limit em /health/*', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 10; i++) {
      const res = await request(server).get('/health/live');
      expect(res.status).toBe(200);
    }
  });
});

/**
 * Cenário crítico do bug §3.1 do feedback:
 *   TTL expira → todos os providers 5xx → API deve servir stale do cache.
 *
 * Sobe uma app separada com CACHE_TTL_MS=50 pra simular expiração rápida.
 */
describe('CEP API — stale cache fallback (e2e)', () => {
  let app: INestApplication;
  const originalTtl = process.env.CACHE_TTL_MS;

  beforeAll(async () => {
    process.env.CACHE_TTL_MS = '50';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new CepExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (originalTtl === undefined) delete process.env.CACHE_TTL_MS;
    else process.env.CACHE_TTL_MS = originalTtl;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('popula cache, TTL expira, providers caem → 200 com cached=true (stale)', async () => {
    // 1) primeira request popula o cache
    mockFetchImpl(async (url) => {
      const u = String(url);
      if (u.includes('viacep')) {
        return jsonResponse(200, {
          cep: '04567-890',
          logradouro: 'Rua Teste',
          bairro: 'Centro',
          localidade: 'São Paulo',
          uf: 'SP',
        });
      }
      return jsonResponse(500, {});
    });

    const warm = await request(app.getHttpServer()).get('/cep/04567890');
    expect(warm.status).toBe(200);
    expect(warm.body.cached).toBe(false);

    jest.restoreAllMocks();

    // 2) espera TTL expirar
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 3) providers agora falham
    mockFetchImpl(async () => new Response('', { status: 503 }));

    const staleRes = await request(app.getHttpServer()).get('/cep/04567890');

    // serviu stale (não 503)
    expect(staleRes.status).toBe(200);
    expect(staleRes.body).toMatchObject({
      cep: '04567890',
      street: 'Rua Teste',
      cached: true,
    });
  });
});
