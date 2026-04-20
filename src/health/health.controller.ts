import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { CircuitBreakerFactory } from '../cep/providers/circuit-breaker.factory';

type CircuitState = 'closed' | 'half_open' | 'open';

interface CircuitStatus {
  provider: string;
  state: CircuitState;
}

interface ReadyResponse {
  status: 'ready';
  circuits: CircuitStatus[];
}

@Controller('health')
export class HealthController {
  constructor(private readonly breakerFactory: CircuitBreakerFactory) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): ReadyResponse {
    const circuits = this.breakerFactory.all().map(({ name, breaker }) => ({
      provider: name,
      state: this.stateOf(breaker.opened, breaker.halfOpen),
    }));

    // Se nenhum breaker foi registrado ainda (ex: antes da primeira requisição),
    // consideramos ready — há providers disponíveis, só não exercitados.
    const anyUp =
      circuits.length === 0 || circuits.some((c) => c.state !== 'open');

    if (!anyUp) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        circuits,
      });
    }

    return { status: 'ready', circuits };
  }

  private stateOf(opened: boolean, halfOpen: boolean): CircuitState {
    if (opened) return 'open';
    if (halfOpen) return 'half_open';
    return 'closed';
  }
}
