import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { CepCacheService } from './cache/cep-cache.service';
import type { CepResponseDto } from './dto/cep-response.dto';
import {
  AllProvidersUnavailableError,
  CepNotFoundError,
  ProviderAttempt,
  ProviderError,
} from './errors/cep.errors';
import { CircuitBreakerFactory } from './providers/circuit-breaker.factory';
import { ProviderSelectorService } from './providers/provider-selector.service';

@Injectable()
export class CepService {
  private readonly logger = new Logger(CepService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<Env, true>,
    private readonly selector: ProviderSelectorService,
    private readonly breakers: CircuitBreakerFactory,
    private readonly cache: CepCacheService,
  ) {
    this.timeoutMs = config.get('PROVIDER_TIMEOUT_MS', { infer: true }) as number;
  }

  async lookup(cep: string): Promise<CepResponseDto> {
    const cached = this.cache.get(cep);
    if (cached && !cached.stale) {
      return { ...cached.data, cached: true };
    }

    const attempts: ProviderAttempt[] = [];

    for (const provider of this.selector.getOrder()) {
      const breaker = this.breakers.get(provider);

      if (breaker.opened) {
        attempts.push({ provider: provider.name, reason: 'circuit_open' });
        continue;
      }

      const start = Date.now();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        const data = await breaker.fire(cep, signal);
        this.cache.set(cep, { ...data, provider: provider.name });
        return { ...data, provider: provider.name, cached: false };
      } catch (err) {
        if (err instanceof CepNotFoundError) {
          throw err;
        }

        const latencyMs = Date.now() - start;
        const reason = this.reasonOf(err, breaker.opened);
        attempts.push({ provider: provider.name, reason, latencyMs });
        this.logger.warn(
          { provider: provider.name, reason, latencyMs },
          'provider attempt failed',
        );
      }
    }

    if (cached?.stale) {
      this.logger.warn(
        { cep, attempts },
        'serving stale cache — all providers unavailable',
      );
      return { ...cached.data, cached: true };
    }

    throw new AllProvidersUnavailableError(attempts);
  }

  private reasonOf(err: unknown, breakerOpened: boolean): string {
    if (err instanceof ProviderError) {
      return err.reason;
    }
    if (breakerOpened) {
      return 'circuit_open';
    }
    if (err instanceof Error && /breaker is open/i.test(err.message)) {
      return 'circuit_open';
    }
    if (err instanceof Error && /timed out/i.test(err.message)) {
      return 'timeout';
    }
    return 'unknown';
  }
}
