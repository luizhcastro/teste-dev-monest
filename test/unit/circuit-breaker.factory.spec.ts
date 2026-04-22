import { ConfigService } from '@nestjs/config';
import {
  CepNotFoundError,
  ProviderHttpError,
} from '../../src/cep/errors/cep.errors';
import type { CepProvider } from '../../src/cep/providers/cep-provider.interface';
import { CircuitBreakerFactory } from '../../src/cep/providers/circuit-breaker.factory';

function makeFactory(overrides: Partial<Record<string, number>> = {}): CircuitBreakerFactory {
  const values: Record<string, number> = {
    PROVIDER_TIMEOUT_MS: 1000,
    CIRCUIT_ERROR_THRESHOLD_PERCENTAGE: 50,
    CIRCUIT_VOLUME_THRESHOLD: 2,
    CIRCUIT_RESET_TIMEOUT_MS: 50,
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService<never, true>;
  const factory = new CircuitBreakerFactory(config);
  factory.onModuleInit();
  return factory;
}

function makeProvider(
  name: string,
  fetchImpl: (cep: string) => Promise<unknown>,
): CepProvider {
  return {
    name,
    fetch: jest.fn((cep: string) => fetchImpl(cep)) as never,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('CircuitBreakerFactory', () => {
  let factory: CircuitBreakerFactory;

  afterEach(() => {
    factory?.onModuleDestroy();
  });

  it('reutiliza o mesmo breaker para o mesmo provider', () => {
    factory = makeFactory();
    const provider = makeProvider('viacep', async () => ({ ok: true }));

    const b1 = factory.get(provider);
    const b2 = factory.get(provider);

    expect(b1).toBe(b2);
  });

  it('breakers separados por provider', () => {
    factory = makeFactory();
    const a = factory.get(makeProvider('a', async () => ({})));
    const b = factory.get(makeProvider('b', async () => ({})));

    expect(a).not.toBe(b);
    expect(factory.all()).toHaveLength(2);
  });

  describe('errorFilter — CepNotFoundError não abre o circuito', () => {
    it('10 404s seguidos mantêm o circuito CLOSED', async () => {
      factory = makeFactory();
      const provider = makeProvider('viacep', async () => {
        throw new CepNotFoundError('00000000');
      });
      const breaker = factory.get(provider);

      for (let i = 0; i < 10; i++) {
        await expect(
          breaker.fire('00000000', new AbortController().signal),
        ).rejects.toBeInstanceOf(CepNotFoundError);
      }

      expect(breaker.opened).toBe(false);
      expect(breaker.halfOpen).toBe(false);
    });

    it('404s contam como sucesso no opossum — só falhas reais movem o ratio', async () => {
      factory = makeFactory({ CIRCUIT_VOLUME_THRESHOLD: 2 });
      let call = 0;
      const provider = makeProvider('viacep', async () => {
        call++;
        if (call <= 3) throw new CepNotFoundError('00000000');
        throw new ProviderHttpError('viacep', 500);
      });
      const breaker = factory.get(provider);

      for (let i = 0; i < 3; i++) {
        await expect(
          breaker.fire('x', new AbortController().signal),
        ).rejects.toBeInstanceOf(CepNotFoundError);
      }
      expect(breaker.opened).toBe(false);

      for (let i = 0; i < 4; i++) {
        await expect(
          breaker.fire('x', new AbortController().signal),
        ).rejects.toBeInstanceOf(ProviderHttpError);
      }
      expect(breaker.opened).toBe(true);
    });
  });

  describe('ciclo closed → open → half-open', () => {
    it('abre o circuito após errorThreshold', async () => {
      factory = makeFactory();
      const provider = makeProvider('brasilapi', async () => {
        throw new ProviderHttpError('brasilapi', 503);
      });
      const breaker = factory.get(provider);

      expect(breaker.opened).toBe(false);

      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.fire('01310100', new AbortController().signal),
        ).rejects.toBeInstanceOf(ProviderHttpError);
      }

      expect(breaker.opened).toBe(true);
    });

    it('após resetTimeout, próxima chamada entra em half-open', async () => {
      factory = makeFactory();
      let shouldFail = true;
      const provider = makeProvider('brasilapi', async () => {
        if (shouldFail) throw new ProviderHttpError('brasilapi', 503);
        return {
          cep: '01310100',
          street: 'x',
          neighborhood: 'y',
          city: 'z',
          state: 'SP',
        };
      });
      const breaker = factory.get(provider);

      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.fire('01310100', new AbortController().signal),
        ).rejects.toBeDefined();
      }
      expect(breaker.opened).toBe(true);

      await sleep(80);

      shouldFail = false;
      const data = await breaker.fire(
        '01310100',
        new AbortController().signal,
      );
      expect(data.state).toBe('SP');
      expect(breaker.opened).toBe(false);
    });

    it('se a probe half-open falha, circuito volta a OPEN', async () => {
      factory = makeFactory();
      const provider = makeProvider('brasilapi', async () => {
        throw new ProviderHttpError('brasilapi', 503);
      });
      const breaker = factory.get(provider);

      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.fire('01310100', new AbortController().signal),
        ).rejects.toBeDefined();
      }
      expect(breaker.opened).toBe(true);

      await sleep(80);

      await expect(
        breaker.fire('01310100', new AbortController().signal),
      ).rejects.toBeInstanceOf(ProviderHttpError);

      expect(breaker.opened).toBe(true);
    });
  });

  it('onModuleDestroy faz shutdown e limpa o mapa', () => {
    factory = makeFactory();
    factory.get(makeProvider('a', async () => ({})));
    factory.get(makeProvider('b', async () => ({})));

    expect(factory.all()).toHaveLength(2);

    factory.onModuleDestroy();

    expect(factory.all()).toHaveLength(0);
  });
});
