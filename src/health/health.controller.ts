import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
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

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly breakerFactory: CircuitBreakerFactory) {}

  @Get('live')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Retorna 200 enquanto o processo estiver de pé.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { status: { type: 'string', example: 'ok' } },
    },
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Retorna 200 se pelo menos um circuito está disponível (closed ou half-open). 503 quando todos os circuitos estão abertos — sinaliza pro load balancer parar de mandar tráfego sem matar o pod.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ready' },
        circuits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              provider: { type: 'string', example: 'viacep' },
              state: {
                type: 'string',
                enum: ['closed', 'half_open', 'open'],
              },
            },
          },
        },
      },
    },
  })
  @ApiServiceUnavailableResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'not_ready' },
        circuits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              provider: { type: 'string', example: 'viacep' },
              state: {
                type: 'string',
                enum: ['closed', 'half_open', 'open'],
              },
            },
          },
        },
      },
    },
  })
  ready(): ReadyResponse {
    const circuits = this.breakerFactory.all().map(({ name, breaker }) => ({
      provider: name,
      state: this.stateOf(breaker.opened, breaker.halfOpen),
    }));

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
