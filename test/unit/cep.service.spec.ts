import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { CepCacheService } from '../../src/cep/cache/cep-cache.service';
import { CepService } from '../../src/cep/cep.service';
import {
  AllProvidersUnavailableError,
  CepNotFoundError,
  ProviderHttpError,
  ProviderTimeoutError,
} from '../../src/cep/errors/cep.errors';
import type { CepProvider } from '../../src/cep/providers/cep-provider.interface';
import { CircuitBreakerFactory } from '../../src/cep/providers/circuit-breaker.factory';
import { ProviderSelectorService } from '../../src/cep/providers/provider-selector.service';
import { mockCachedData, mockCepData } from '../fixtures/mock-cep-data';

interface MockBreaker {
  opened: boolean;
  fire: jest.Mock<Promise<unknown>, [string, AbortSignal]>;
}

describe('CepService', () => {
  let service: CepService;
  let providerA: jest.Mocked<CepProvider>;
  let providerB: jest.Mocked<CepProvider>;
  let breakerA: MockBreaker;
  let breakerB: MockBreaker;
  let cache: jest.Mocked<CepCacheService>;

  beforeEach(async () => {
    providerA = { name: 'A', fetch: jest.fn() };
    providerB = { name: 'B', fetch: jest.fn() };

    breakerA = { opened: false, fire: jest.fn() };
    breakerB = { opened: false, fire: jest.fn() };

    // Por padrão breaker.fire delega pro fetch do provider
    breakerA.fire.mockImplementation((cep, signal) =>
      providerA.fetch(cep, signal),
    );
    breakerB.fire.mockImplementation((cep, signal) =>
      providerB.fetch(cep, signal),
    );

    const breakerFactory: Partial<CircuitBreakerFactory> = {
      get: jest.fn((p: CepProvider) =>
        p.name === 'A' ? (breakerA as never) : (breakerB as never),
      ),
    };

    const selector: Partial<ProviderSelectorService> = {
      getOrder: () => [providerA, providerB],
    };

    cache = {
      get: jest.fn(),
      set: jest.fn(),
      clear: jest.fn(),
      size: jest.fn(),
    } as unknown as jest.Mocked<CepCacheService>;

    const config: Partial<ConfigService> = {
      get: jest.fn(() => 3000),
    };

    const pinoLogger: Partial<PinoLogger> = {
      setContext: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CepService,
        { provide: ConfigService, useValue: config },
        { provide: CircuitBreakerFactory, useValue: breakerFactory },
        { provide: ProviderSelectorService, useValue: selector },
        { provide: CepCacheService, useValue: cache },
        { provide: PinoLogger, useValue: pinoLogger },
      ],
    }).compile();

    service = moduleRef.get(CepService);
  });

  it('retorna sucesso no primeiro provider e cacheia', async () => {
    providerA.fetch.mockResolvedValue(mockCepData);

    const result = await service.lookup('01310100');

    expect(result).toMatchObject({
      ...mockCepData,
      provider: 'A',
      cached: false,
    });
    expect(providerB.fetch).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith('01310100', {
      ...mockCepData,
      provider: 'A',
    });
  });

  it('faz fallback quando o primeiro dá timeout', async () => {
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockResolvedValue(mockCepData);

    const result = await service.lookup('01310100');

    expect(result.provider).toBe('B');
    expect(providerA.fetch).toHaveBeenCalled();
    expect(providerB.fetch).toHaveBeenCalled();
  });

  it('404 no primeiro NÃO dispara fallback (regra de ouro)', async () => {
    providerA.fetch.mockRejectedValue(new CepNotFoundError('00000000'));

    await expect(service.lookup('00000000')).rejects.toBeInstanceOf(
      CepNotFoundError,
    );
    expect(providerB.fetch).not.toHaveBeenCalled();
  });

  it('todos falham → AllProvidersUnavailableError com attempts', async () => {
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockRejectedValue(new ProviderHttpError('B', 502));

    await expect(service.lookup('01310100')).rejects.toMatchObject({
      status: 503,
      code: 'all_providers_unavailable',
    });

    try {
      await service.lookup('01310100');
    } catch (err) {
      const e = err as AllProvidersUnavailableError;
      expect(e.attempts).toHaveLength(2);
      expect(e.attempts[0]).toMatchObject({ provider: 'A', reason: 'timeout' });
      expect(e.attempts[1]).toMatchObject({
        provider: 'B',
        reason: 'http_error',
      });
    }
  });

  it('cache hit fresh não chama provider', async () => {
    cache.get.mockReturnValue({ data: mockCachedData, stale: false });

    const result = await service.lookup('01310100');

    expect(result.cached).toBe(true);
    expect(result.provider).toBe(mockCachedData.provider);
    expect(providerA.fetch).not.toHaveBeenCalled();
    expect(providerB.fetch).not.toHaveBeenCalled();
  });

  it('todos falham mas tem stale → serve stale em vez de 503', async () => {
    cache.get.mockReturnValue({ data: mockCachedData, stale: true });
    providerA.fetch.mockRejectedValue(new ProviderTimeoutError('A'));
    providerB.fetch.mockRejectedValue(new ProviderTimeoutError('B'));

    const result = await service.lookup('01310100');

    expect(result.cached).toBe(true);
    expect(result.provider).toBe(mockCachedData.provider);
  });

  it('pula provider com circuito aberto', async () => {
    breakerA.opened = true;
    providerB.fetch.mockResolvedValue(mockCepData);

    const result = await service.lookup('01310100');

    expect(providerA.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('B');
  });
});
