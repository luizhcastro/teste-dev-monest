import { CepParamPipe, normalizeCep } from '../../src/cep/dto/cep-param.dto';
import { InvalidCepError } from '../../src/cep/errors/cep.errors';

describe('normalizeCep', () => {
  it('removes hyphen', () => {
    expect(normalizeCep('01310-100')).toBe('01310100');
  });

  it('keeps CEP with digits only', () => {
    expect(normalizeCep('01310100')).toBe('01310100');
  });

  it('removes surrounding whitespace', () => {
    expect(normalizeCep('  01310100  ')).toBe('01310100');
  });
});

describe('CepParamPipe', () => {
  const pipe = new CepParamPipe();

  it('accepts 8 digits', () => {
    expect(pipe.transform('01310100')).toBe('01310100');
  });

  it('accepts hyphenated CEP and normalizes it', () => {
    expect(pipe.transform('01310-100')).toBe('01310100');
  });

  it('rejects letters', () => {
    expect(() => pipe.transform('abc')).toThrow(InvalidCepError);
  });

  it('rejects less than 8 digits', () => {
    expect(() => pipe.transform('12345')).toThrow(InvalidCepError);
  });

  it('rejects more than 8 digits', () => {
    expect(() => pipe.transform('123456789')).toThrow(InvalidCepError);
  });

  it('rejects empty string', () => {
    expect(() => pipe.transform('')).toThrow(InvalidCepError);
  });
});
