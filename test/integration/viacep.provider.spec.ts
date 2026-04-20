import { ConfigService } from '@nestjs/config';
import {
  CepNotFoundError,
  ProviderContractError,
  ProviderHttpError,
  ProviderTimeoutError,
} from '../../src/cep/errors/cep.errors';
import { ViaCepProvider } from '../../src/cep/providers/viacep.provider';

const BASE_URL = 'https://viacep.com.br';

function makeProvider(): ViaCepProvider {
  const config = {
    get: jest.fn((key: string) =>
      key === 'VIACEP_URL' ? BASE_URL : undefined,
    ),
  } as unknown as ConfigService<never, true>;
  return new ViaCepProvider(config);
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

describe('ViaCepProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parseia resposta de sucesso e normaliza os campos', async () => {
    const spy = mockFetch(async () =>
      jsonResponse(200, {
        cep: '01310-100',
        logradouro: 'Avenida Paulista',
        bairro: 'Bela Vista',
        localidade: 'São Paulo',
        uf: 'SP',
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
      `${BASE_URL}/ws/01310100/json/`,
      expect.anything(),
    );
  });

  it('{erro:true} vira CepNotFoundError', async () => {
    mockFetch(async () => jsonResponse(200, { erro: true }));

    const provider = makeProvider();
    await expect(
      provider.fetch('00000000', new AbortController().signal),
    ).rejects.toBeInstanceOf(CepNotFoundError);
  });

  it('contrato diferente vira ProviderContractError', async () => {
    mockFetch(async () => jsonResponse(200, { inesperado: 'payload' }));

    const provider = makeProvider();
    await expect(
      provider.fetch('01310100', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });

  it('5xx vira ProviderHttpError', async () => {
    mockFetch(async () => new Response('', { status: 503 }));

    const provider = makeProvider();
    await expect(
      provider.fetch('01310100', new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderHttpError);
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
