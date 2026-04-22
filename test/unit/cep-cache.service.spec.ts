import { ConfigService } from '@nestjs/config';
import {
  CachedCepData,
  CepCacheService,
} from '../../src/cep/cache/cep-cache.service';
import { mockCachedData } from '../fixtures/mock-cep-data';
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeService(
  overrides: { ttl?: number; max?: number } = {},
): CepCacheService {
  const values: Record<string, number> = {
    CACHE_MAX_ENTRIES: overrides.max ?? 10,
    CACHE_TTL_MS: overrides.ttl ?? 1000,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService<never, true>;
  return new CepCacheService(config);
}

const cached: CachedCepData = { ...mockCachedData };

describe('CepCacheService', () => {
  it('retorna undefined para CEP não cacheado', () => {
    const cache = makeService();
    expect(cache.get('01310100')).toBeUndefined();
  });

  it('retorna fresh enquanto dentro do TTL', async () => {
    const cache = makeService({ ttl: 100 });
    cache.set('01310100', cached);

    await sleep(20);

    expect(cache.get('01310100')).toEqual({ data: cached, stale: false });
  });

  it('após TTL, primeira leitura retorna stale (e não fresh)', async () => {
    const cache = makeService({ ttl: 40 });
    cache.set('01310100', cached);

    await sleep(80);

    expect(cache.get('01310100')).toEqual({ data: cached, stale: true });
  });

  it('segunda leitura após TTL retorna undefined (entrada foi consumida)', async () => {
    const cache = makeService({ ttl: 40 });
    cache.set('01310100', cached);

    await sleep(80);

    const first = cache.get('01310100');
    const second = cache.get('01310100');

    expect(first).toEqual({ data: cached, stale: true });
    expect(second).toBeUndefined();
  });

  it('set renova o TTL', async () => {
    const cache = makeService({ ttl: 50 });
    cache.set('01310100', cached);
    await sleep(30);
    cache.set('01310100', cached);
    await sleep(30);

    expect(cache.get('01310100')).toEqual({ data: cached, stale: false });
  });

  it('evicção por max — LRU descarta o mais antigo', () => {
    const cache = makeService({ max: 2 });
    cache.set('a', { ...cached, cep: 'a' });
    cache.set('b', { ...cached, cep: 'b' });
    cache.set('c', { ...cached, cep: 'c' });

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual({
      data: { ...cached, cep: 'b' },
      stale: false,
    });
    expect(cache.get('c')).toEqual({
      data: { ...cached, cep: 'c' },
      stale: false,
    });
    expect(cache.size()).toBe(2);
  });

  it('clear() esvazia o cache', () => {
    const cache = makeService();
    cache.set('01310100', cached);
    expect(cache.size()).toBe(1);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('01310100')).toBeUndefined();
  });
});
