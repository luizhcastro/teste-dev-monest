export interface ProviderAttempt {
  provider: string;
  reason: string;
  latencyMs?: number;
}

export abstract class CepApiError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
}

export class InvalidCepError extends CepApiError {
  readonly status = 400;
  readonly code = 'invalid_cep';

  constructor(readonly input: string) {
    super(`Invalid CEP format: ${input}`);
    this.name = 'InvalidCepError';
  }
}

export class CepNotFoundError extends CepApiError {
  readonly status = 404;
  readonly code = 'cep_not_found';

  constructor(readonly cep: string) {
    super(`CEP ${cep} not found`);
    this.name = 'CepNotFoundError';
  }
}

export class AllProvidersUnavailableError extends CepApiError {
  readonly status = 503;
  readonly code = 'all_providers_unavailable';

  constructor(readonly attempts: ProviderAttempt[]) {
    super('All providers are unavailable');
    this.name = 'AllProvidersUnavailableError';
  }
}

export abstract class ProviderError extends Error {
  abstract readonly reason: string;

  constructor(readonly provider: string, cause?: unknown) {
    super(
      `Provider ${provider} failed: ${
        cause instanceof Error ? cause.message : 'unknown'
      }`,
    );
    this.name = new.target.name;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly reason = 'timeout';
}

export class ProviderHttpError extends ProviderError {
  readonly reason = 'http_error';

  constructor(
    provider: string,
    readonly statusCode: number,
    cause?: unknown,
  ) {
    super(provider, cause);
  }
}

export class ProviderNetworkError extends ProviderError {
  readonly reason = 'network_error';
}

export class ProviderContractError extends ProviderError {
  readonly reason = 'contract_error';
}
