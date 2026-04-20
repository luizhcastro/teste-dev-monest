import { Module } from '@nestjs/common';
import { CepCacheService } from './cache/cep-cache.service';
import { BrasilApiProvider } from './providers/brasilapi.provider';
import { CEP_PROVIDERS } from './providers/cep-provider.interface';
import { CircuitBreakerFactory } from './providers/circuit-breaker.factory';
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
    CircuitBreakerFactory,
    CepCacheService,
  ],
  exports: [
    CEP_PROVIDERS,
    ProviderSelectorService,
    CircuitBreakerFactory,
    CepCacheService,
  ],
})
export class CepModule {}
