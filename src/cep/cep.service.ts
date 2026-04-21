import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanStatusCode } from '@opentelemetry/api';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.validation';
import {
  cacheHitsTotal,
  cacheMissesTotal,
  cacheStaleHitsTotal,
  cepLookupDuration,
  cepLookupTotal,
  providerDuration,
  providerRequestsTotal,
  tracer,
} from '../common/telemetry/tracer';
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
  private readonly timeoutMs: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<Env, true>,
    private readonly selector: ProviderSelectorService,
    private readonly breakers: CircuitBreakerFactory,
    private readonly cache: CepCacheService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CepService.name);
    this.timeoutMs = config.get('PROVIDER_TIMEOUT_MS', {
      infer: true,
    }) as number;
  }

  async lookup(cep: string): Promise<CepResponseDto> {
    return tracer.startActiveSpan('cep.lookup', async (span) => {
      span.setAttribute('cep', cep);
      const lookupStart = Date.now();

      try {
        const cached = this.cache.get(cep);
        if (cached && !cached.stale) {
          cacheHitsTotal.add(1);
          span.setAttribute('cep.cached', true);
          span.setAttribute('cep.provider', cached.data.provider);
          this.recordLookupMetrics('cached', lookupStart);
          span.setStatus({ code: SpanStatusCode.OK });
          return { ...cached.data, cached: true };
        }

        cacheMissesTotal.add(1);

        const attempts: ProviderAttempt[] = [];

        for (const provider of this.selector.getOrder()) {
          const breaker = this.breakers.get(provider);

          if (breaker.opened) {
            attempts.push({ provider: provider.name, reason: 'circuit_open' });
            providerRequestsTotal.add(1, {
              provider: provider.name,
              outcome: 'circuit_open',
            });
            continue;
          }

          const start = Date.now();
          try {
            const signal = AbortSignal.timeout(this.timeoutMs);
            const data = await breaker.fire(cep, signal);
            const latencyMs = Date.now() - start;

            this.cache.set(cep, { ...data, provider: provider.name });
            this.recordProviderMetrics(provider.name, 'ok', latencyMs);
            span.setAttribute('cep.cached', false);
            span.setAttribute('cep.provider', provider.name);
            span.setAttribute('cep.attempts', attempts.length + 1);
            this.recordLookupMetrics('ok', lookupStart);
            span.setStatus({ code: SpanStatusCode.OK });
            return { ...data, provider: provider.name, cached: false };
          } catch (err) {
            const latencyMs = Date.now() - start;

            if (err instanceof CepNotFoundError) {
              this.recordProviderMetrics(provider.name, 'not_found', latencyMs);
              this.recordLookupMetrics('not_found', lookupStart);
              span.setAttribute('cep.provider', provider.name);
              span.setStatus({ code: SpanStatusCode.OK });
              throw err;
            }

            const reason = this.reasonOf(err, breaker.opened);
            attempts.push({ provider: provider.name, reason, latencyMs });
            this.recordProviderMetrics(provider.name, reason, latencyMs);
            this.logger.warn(
              { provider: provider.name, reason, latencyMs },
              'provider attempt failed',
            );
          }
        }

        if (cached?.stale) {
          cacheStaleHitsTotal.add(1);
          this.logger.warn(
            { cep, attempts },
            'serving stale cache — all providers unavailable',
          );
          span.setAttribute('cep.cached', true);
          span.setAttribute('cep.stale', true);
          span.setAttribute('cep.provider', cached.data.provider);
          this.recordLookupMetrics('stale', lookupStart);
          span.setStatus({ code: SpanStatusCode.OK });
          return { ...cached.data, cached: true };
        }

        this.recordLookupMetrics('all_failed', lookupStart);
        throw new AllProvidersUnavailableError(attempts);
      } catch (err) {
        if (!(err instanceof CepNotFoundError)) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
        }
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private recordLookupMetrics(status: string, startedAt: number): void {
    const seconds = (Date.now() - startedAt) / 1000;
    cepLookupTotal.add(1, { status });
    cepLookupDuration.record(seconds, { status });
  }

  private recordProviderMetrics(
    provider: string,
    outcome: string,
    latencyMs: number,
  ): void {
    providerRequestsTotal.add(1, { provider, outcome });
    providerDuration.record(latencyMs / 1000, { provider, outcome });
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
