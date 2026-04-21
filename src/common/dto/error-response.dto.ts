import { ApiProperty } from '@nestjs/swagger';

export class ProviderAttemptDto {
  @ApiProperty({ example: 'viacep' })
  provider!: string;

  @ApiProperty({
    example: 'timeout',
    enum: [
      'timeout',
      'http_error',
      'network_error',
      'contract_error',
      'circuit_open',
      'unknown',
    ],
  })
  reason!: string;

  @ApiProperty({ example: 3001, required: false })
  latencyMs?: number;
}

export class ErrorResponseDto {
  @ApiProperty({
    example: 'invalid_cep',
    enum: [
      'invalid_cep',
      'cep_not_found',
      'all_providers_unavailable',
      'internal_error',
    ],
  })
  error!: string;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Correlation id para rastrear a request em logs/traces',
  })
  correlationId!: string;

  @ApiProperty({ required: false, example: 'CEP inválido: deve ter 8 dígitos' })
  message?: string;

  @ApiProperty({
    type: [ProviderAttemptDto],
    required: false,
    description:
      'Presente apenas em 503 all_providers_unavailable — lista tentativas feitas',
  })
  attempts?: ProviderAttemptDto[];
}
