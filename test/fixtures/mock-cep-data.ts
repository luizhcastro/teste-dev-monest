import type { CepData } from '../../src/cep/providers/cep-provider.interface';

export const mockCepData: CepData = {
  cep: '01310100',
  street: 'Avenida Paulista',
  neighborhood: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
};

export const mockViaCepResponse = {
  cep: '01310-100',
  logradouro: 'Avenida Paulista',
  bairro: 'Bela Vista',
  localidade: 'São Paulo',
  uf: 'SP',
};

export const mockBrasilApiResponse = {
  cep: '01310100',
  street: 'Avenida Paulista',
  neighborhood: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
  service: 'brasilapi',
};

export const mockCachedData = {
  ...mockCepData,
  provider: 'viacep',
};
