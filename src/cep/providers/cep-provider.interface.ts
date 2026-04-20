export const CEP_PROVIDERS = Symbol('CEP_PROVIDERS');

export interface CepData {
  cep: string;
  street: string;
  neighborhood: string;
  city: string;
  state: string;
}

export interface CepProvider {
  readonly name: string;
  fetch(cep: string, signal: AbortSignal): Promise<CepData>;
}
