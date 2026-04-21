import { ApiProperty } from '@nestjs/swagger';

/**
 * Contrato de resposta do endpoint de CEP.
 *
 * Mantido como `class` (não `interface`) porque o `@nestjs/swagger` precisa
 * de metadata em runtime pra gerar o OpenAPI. Uso interno (services, cache)
 * ainda trata como objeto plain — nenhuma lógica fica aqui.
 */
export class CepResponseDto {
  @ApiProperty({
    example: '01310100',
    description: 'CEP normalizado (8 dígitos, sem hífen)',
  })
  cep!: string;

  @ApiProperty({
    example: 'Avenida Paulista',
    description: 'Logradouro',
  })
  street!: string;

  @ApiProperty({
    example: 'Bela Vista',
    description: 'Bairro',
  })
  neighborhood!: string;

  @ApiProperty({ example: 'São Paulo' })
  city!: string;

  @ApiProperty({ example: 'SP', description: 'UF com 2 letras' })
  state!: string;

  @ApiProperty({
    example: 'viacep',
    description: 'Provider que atendeu esta requisição',
    enum: ['viacep', 'brasilapi'],
  })
  provider!: string;

  @ApiProperty({
    example: false,
    description:
      'True se veio do cache em memória (inclui caso stale quando todos providers caíram)',
  })
  cached!: boolean;
}
