import { CepParamPipe, normalizeCep } from '../../src/cep/dto/cep-param.dto';
import { InvalidCepError } from '../../src/cep/errors/cep.errors';

describe('normalizeCep', () => {
  it('remove hífen', () => {
    expect(normalizeCep('01310-100')).toBe('01310100');
  });

  it('mantém CEP só com dígitos', () => {
    expect(normalizeCep('01310100')).toBe('01310100');
  });

  it('remove espaços laterais', () => {
    expect(normalizeCep('  01310100  ')).toBe('01310100');
  });
});

describe('CepParamPipe', () => {
  const pipe = new CepParamPipe();

  it('aceita 8 dígitos', () => {
    expect(pipe.transform('01310100')).toBe('01310100');
  });

  it('aceita com hífen e normaliza', () => {
    expect(pipe.transform('01310-100')).toBe('01310100');
  });

  it('rejeita letras', () => {
    expect(() => pipe.transform('abc')).toThrow(InvalidCepError);
  });

  it('rejeita menos de 8 dígitos', () => {
    expect(() => pipe.transform('12345')).toThrow(InvalidCepError);
  });

  it('rejeita mais de 8 dígitos', () => {
    expect(() => pipe.transform('123456789')).toThrow(InvalidCepError);
  });

  it('rejeita string vazia', () => {
    expect(() => pipe.transform('')).toThrow(InvalidCepError);
  });
});
