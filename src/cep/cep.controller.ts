import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CepService } from './cep.service';
import { CepParamPipe } from './dto/cep-param.dto';
import { CepResponseDto } from './dto/cep-response.dto';

@ApiTags('cep')
@ApiHeader({
  name: 'X-Correlation-Id',
  required: false,
  description:
    'Correlation id opcional. Se vier com UUID v4 válido, é reutilizado; caso contrário, a API gera um novo UUID v4 e o ecoa no response.',
})
@Controller('cep')
export class CepController {
  constructor(private readonly service: CepService) {}

  @Get(':cep')
  @ApiOperation({
    summary: 'Consulta CEP',
    description:
      'Consulta o CEP alternando entre providers externos (ViaCEP e BrasilAPI) com fallback automático, circuit breaker por provider e cache LRU. Aceita com ou sem hífen.',
  })
  @ApiParam({
    name: 'cep',
    example: '01310-100',
    description:
      'CEP com ou sem hífen. Normalizado internamente para 8 dígitos.',
  })
  @ApiOkResponse({
    type: CepResponseDto,
    description:
      'Encontrado. `cached=true` significa que veio do cache em memória.',
  })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'CEP em formato inválido (não contém 8 dígitos).',
  })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'CEP válido mas inexistente nas bases dos providers.',
  })
  @ApiTooManyRequestsResponse({
    type: ErrorResponseDto,
    description:
      'Rate limit excedido para o IP de origem. Header `Retry-After` em segundos.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description:
      'Todos os providers falharam. O corpo inclui `attempts[]` com motivo/latência de cada tentativa. Retry-After: 30.',
  })
  async getCep(
    @Param('cep', CepParamPipe) cep: string,
  ): Promise<CepResponseDto> {
    return this.service.lookup(cep);
  }
}
