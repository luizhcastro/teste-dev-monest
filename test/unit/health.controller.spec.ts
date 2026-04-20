import { ServiceUnavailableException } from '@nestjs/common';
import type { CepBreaker } from '../../src/cep/providers/circuit-breaker.factory';
import { CircuitBreakerFactory } from '../../src/cep/providers/circuit-breaker.factory';
import { HealthController } from '../../src/health/health.controller';

type BreakerStub = Pick<CepBreaker, 'opened' | 'halfOpen'>;

function makeFactory(
  entries: { name: string; breaker: BreakerStub }[],
): CircuitBreakerFactory {
  return {
    all: () => entries as unknown as ReturnType<CircuitBreakerFactory['all']>,
  } as unknown as CircuitBreakerFactory;
}

describe('HealthController', () => {
  describe('live', () => {
    it('sempre retorna { status: ok }', () => {
      const ctrl = new HealthController(makeFactory([]));
      expect(ctrl.live()).toEqual({ status: 'ok' });
    });
  });

  describe('ready', () => {
    it('sem breakers registrados ainda → ready (providers nunca chamados)', () => {
      const ctrl = new HealthController(makeFactory([]));
      expect(ctrl.ready()).toEqual({ status: 'ready', circuits: [] });
    });

    it('com pelo menos um circuito fechado → ready', () => {
      const ctrl = new HealthController(
        makeFactory([
          { name: 'viacep', breaker: { opened: false, halfOpen: false } },
          { name: 'brasilapi', breaker: { opened: true, halfOpen: false } },
        ]),
      );

      const result = ctrl.ready();
      expect(result.status).toBe('ready');
      expect(result.circuits).toEqual([
        { provider: 'viacep', state: 'closed' },
        { provider: 'brasilapi', state: 'open' },
      ]);
    });

    it('half-open conta como up → ready', () => {
      const ctrl = new HealthController(
        makeFactory([
          { name: 'viacep', breaker: { opened: false, halfOpen: true } },
        ]),
      );

      const result = ctrl.ready();
      expect(result.status).toBe('ready');
      expect(result.circuits[0].state).toBe('half_open');
    });

    it('todos breakers abertos → 503 ServiceUnavailable', () => {
      const ctrl = new HealthController(
        makeFactory([
          { name: 'viacep', breaker: { opened: true, halfOpen: false } },
          { name: 'brasilapi', breaker: { opened: true, halfOpen: false } },
        ]),
      );

      expect(() => ctrl.ready()).toThrow(ServiceUnavailableException);
    });
  });
});
