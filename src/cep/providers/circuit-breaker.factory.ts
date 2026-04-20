import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import CircuitBreaker from 'opossum';
import type { Env } from '../../config/env.validation';
import { circuitStateGauge } from '../../common/telemetry/tracer';
import { CepNotFoundError } from '../errors/cep.errors';
import type { CepData, CepProvider } from './cep-provider.interface';

export type CepBreaker = CircuitBreaker<[string, AbortSignal], CepData>;

@Injectable()
export class CircuitBreakerFactory implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CircuitBreakerFactory.name);
  private readonly breakers = new Map<string, CepBreaker>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    circuitStateGauge.addCallback((result) => {
      for (const { name, breaker } of this.all()) {
        const state = breaker.opened ? 2 : breaker.halfOpen ? 1 : 0;
        result.observe(state, { provider: name });
      }
    });
  }

  get(provider: CepProvider): CepBreaker {
    const existing = this.breakers.get(provider.name);
    if (existing) return existing;

    const breaker: CepBreaker = new CircuitBreaker(
      (cep: string, signal: AbortSignal) => provider.fetch(cep, signal),
      {
        timeout: this.config.get('PROVIDER_TIMEOUT_MS', { infer: true }),
        errorThresholdPercentage: this.config.get(
          'CIRCUIT_ERROR_THRESHOLD_PERCENTAGE',
          { infer: true },
        ),
        volumeThreshold: this.config.get('CIRCUIT_VOLUME_THRESHOLD', {
          infer: true,
        }),
        resetTimeout: this.config.get('CIRCUIT_RESET_TIMEOUT_MS', {
          infer: true,
        }),
        errorFilter: (err: unknown) => err instanceof CepNotFoundError,
        name: provider.name,
      },
    );

    this.attachTelemetry(breaker, provider.name);
    this.breakers.set(provider.name, breaker);
    return breaker;
  }

  all(): { name: string; breaker: CepBreaker }[] {
    return Array.from(this.breakers.entries()).map(([name, breaker]) => ({
      name,
      breaker,
    }));
  }

  private attachTelemetry(breaker: CepBreaker, name: string): void {
    breaker.on('open', () => {
      this.logger.warn({ provider: name }, 'circuit opened');
    });
    breaker.on('halfOpen', () => {
      this.logger.log({ provider: name }, 'circuit half-open');
    });
    breaker.on('close', () => {
      this.logger.log({ provider: name }, 'circuit closed');
    });
  }

  onModuleDestroy(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
    this.breakers.clear();
  }
}
