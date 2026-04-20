import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import {
  CepNotFoundError,
  ProviderContractError,
  ProviderHttpError,
} from '../errors/cep.errors';
import { viaCepSchema } from '../schemas/viacep.schema';
import { CepProvider, CepData } from './cep-provider.interface';
import { mapFetchError } from './fetch-error.mapper';

@Injectable()
export class ViaCepProvider implements CepProvider {
  readonly name = 'viacep';
  private readonly baseUrl: string;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {
    this.baseUrl = this.config.get('VIACEP_URL', { infer: true });
  }

  async fetch(cep: string, signal: AbortSignal): Promise<CepData> {
    const url = `${this.baseUrl}/ws/${cep}/json/`;

    let response: Response;
    try {
      response = await globalThis.fetch(url, { signal });
    } catch (err) {
      throw mapFetchError(this.name, err);
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

    const parsed = viaCepSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(this.name, parsed.error);
    }

    if ('erro' in parsed.data) {
      throw new CepNotFoundError(cep);
    }

    return {
      cep,
      street: parsed.data.logradouro,
      neighborhood: parsed.data.bairro,
      city: parsed.data.localidade,
      state: parsed.data.uf,
    };
  }
}
