import { Injectable, PipeTransform } from '@nestjs/common';
import { InvalidCepError } from '../errors/cep.errors';

const CEP_REGEX = /^\d{8}$/;

export function normalizeCep(input: string): string {
  return input.replace(/-/g, '').trim();
}

@Injectable()
export class CepParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string') {
      throw new InvalidCepError(String(value));
    }
    const normalized = normalizeCep(value);
    if (!CEP_REGEX.test(normalized)) {
      throw new InvalidCepError(value);
    }
    return normalized;
  }
}
