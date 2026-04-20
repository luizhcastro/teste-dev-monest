import {
  ProviderError,
  ProviderNetworkError,
  ProviderTimeoutError,
} from '../errors/cep.errors';

export function mapFetchError(provider: string, err: unknown): ProviderError {
  if (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return new ProviderTimeoutError(provider, err);
  }
  return new ProviderNetworkError(provider, err);
}
