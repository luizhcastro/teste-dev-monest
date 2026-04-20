import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import {
  CepNotFoundError,
  ProviderContractError,
  ProviderHttpError,
} from '../errors/cep.errors';
import { brasilApiSchema } from '../schemas/brasilapi.schema';
import { CepProvider, CepData } from './cep-provider.interface';
import { mapFetchError } from './fetch-error.mapper';

@Injectable()
export class BrasilApiProvider implements CepProvider {
  readonly name = 'brasilapi';
  private readonly baseUrl: string;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {
    this.baseUrl = this.config.get('BRASILAPI_URL', { infer: true });
  }

  async fetch(cep: string, signal: AbortSignal): Promise<CepData> {
    const url = `${this.baseUrl}/api/cep/v1/${cep}`;

    let response: Response;
    try {
      response = await globalThis.fetch(url, { signal });
    } catch (err) {
      throw mapFetchError(this.name, err);
    }

    if (response.status === 404) {
      throw new CepNotFoundError(cep);
    }

    if (!response.ok) {
      throw new ProviderHttpError(this.name, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new ProviderContractError(this.name, err);
    }

    const parsed = brasilApiSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(this.name, parsed.error);
    }

    return {
      cep,
      street: parsed.data.street,
      neighborhood: parsed.data.neighborhood,
      city: parsed.data.city,
      state: parsed.data.state,
    };
  }
}
