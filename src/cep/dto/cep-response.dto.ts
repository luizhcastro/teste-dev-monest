import type { CepData } from '../providers/cep-provider.interface';

export interface CepResponseDto extends CepData {
  provider: string;
  cached: boolean;
}
