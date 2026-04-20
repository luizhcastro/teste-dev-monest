import { Module } from '@nestjs/common';
import { BrasilApiProvider } from './providers/brasilapi.provider';
import { CEP_PROVIDERS } from './providers/cep-provider.interface';
import { ProviderSelectorService } from './providers/provider-selector.service';
import { ViaCepProvider } from './providers/viacep.provider';

@Module({
  providers: [
    ViaCepProvider,
    BrasilApiProvider,
    {
      provide: CEP_PROVIDERS,
      useFactory: (viacep: ViaCepProvider, brasilapi: BrasilApiProvider) => [
        viacep,
        brasilapi,
      ],
      inject: [ViaCepProvider, BrasilApiProvider],
    },
    ProviderSelectorService,
  ],
  exports: [CEP_PROVIDERS, ProviderSelectorService],
})
export class CepModule {}
