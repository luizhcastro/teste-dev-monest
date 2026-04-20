import type { CepProvider } from '../../src/cep/providers/cep-provider.interface';
import { ProviderSelectorService } from '../../src/cep/providers/provider-selector.service';

function makeProvider(name: string): CepProvider {
  return { name, fetch: jest.fn() };
}

describe('ProviderSelectorService', () => {
  it('rotaciona a ordem a cada chamada (round-robin)', () => {
    const a = makeProvider('A');
    const b = makeProvider('B');
    const selector = new ProviderSelectorService([a, b]);

    const order1 = selector.getOrder();
    const order2 = selector.getOrder();
    const order3 = selector.getOrder();

    expect(order1.map((p) => p.name)).toEqual(['A', 'B']);
    expect(order2.map((p) => p.name)).toEqual(['B', 'A']);
    expect(order3.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('retorna todos os providers em cada chamada', () => {
    const a = makeProvider('A');
    const b = makeProvider('B');
    const c = makeProvider('C');
    const selector = new ProviderSelectorService([a, b, c]);

    expect(selector.getOrder()).toHaveLength(3);
    expect(selector.getOrder()).toHaveLength(3);
  });

  it('com 3+ providers distribui uniformemente', () => {
    const providers = ['A', 'B', 'C'].map(makeProvider);
    const selector = new ProviderSelectorService(providers);

    const firsts: string[] = [];
    for (let i = 0; i < 6; i++) {
      firsts.push(selector.getOrder()[0].name);
    }

    expect(firsts).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
  });
});
