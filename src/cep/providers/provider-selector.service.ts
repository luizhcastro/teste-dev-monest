import { Inject, Injectable } from '@nestjs/common';
import { CEP_PROVIDERS, CepProvider } from './cep-provider.interface';

@Injectable()
export class ProviderSelectorService {
  private counter = 0;

  constructor(
    @Inject(CEP_PROVIDERS) private readonly providers: CepProvider[],
  ) {}

  getOrder(): CepProvider[] {
    const start = this.counter++ % this.providers.length;
    return [
      ...this.providers.slice(start),
      ...this.providers.slice(0, start),
    ];
  }
}
