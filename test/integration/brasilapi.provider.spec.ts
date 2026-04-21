import { ConfigService } from '@nestjs/config';
import {
  CepNotFoundError,
  ProviderContractError,
  ProviderHttpError,
  ProviderTimeoutError,
} from '../../src/cep/errors/cep.errors';
import { BrasilApiProvider } from '../../src/cep/providers/brasilapi.provider';

const BASE_URL = 'https://brasilapi.com.br';

function makeProvider(): BrasilApiProvider {
  const config = {
    get: jest.fn((key: string) =>
      key === 'BRASILAPI_URL' ? BASE_URL : undefined,
    ),
  } as unknown as ConfigService<never, true>;
  return new BrasilApiProvider(config);
}

function mockFetch(impl: typeof fetch): jest.SpyInstance {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(impl as never) as jest.SpyInstance;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BrasilApiProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses successful response', async () => {
    const spy = mockFetch(async () =>
      jsonResponse(200, {
        cep: '01310100',
        street: 'Avenida Paulista',
        neighborhood: 'Bela Vista',
        city: 'São Paulo',
        state: 'SP',
        service: 'brasilapi',
      }),
    );

    const provider = makeProvider();
    const data = await provider.fetch(
      '01310100',
      new AbortController().signal,
    );

    expect(data).toEqual({
      cep: '01310100',
      street: 'Avenida Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
    expect(spy).toHaveBeenCalledWith(
      `${BASE_URL}/api/cep/v1/01310100`,
      expect.anything(),
    );
  });

  it('404 becomes CepNotFoundError', async () => {
    mockFetch(async () => jsonResponse(404, {}));

    const provider = makeProvider();
    await expect(
      provider.fetch('00000000', new AbortController().signal),
    ).rejects.toBeInstanceOf(CepNotFoundError);
  });

  it('5xx vira ProviderHttpError', async () => {
    mockFetch(async () => new Response('', { status: 503 }));

    const provider = makeProvider();
    await expect(
      provider.fetch('01310100', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('unexpected contract becomes ProviderContractError', async () => {
    mockFetch(async () => jsonResponse(200, { unexpected: 'field' }));

    const provider = makeProvider();
    await expect(
      provider.fetch('01310100', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('AbortSignal cancela a chamada → ProviderTimeoutError', async () => {
    mockFetch(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener('abort', onAbort, { once: true });
        }
      });
    });

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    const provider = makeProvider();
    await expect(
      provider.fetch('01310100', ctrl.signal),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});
