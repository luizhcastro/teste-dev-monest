import { Controller, Get, Param } from '@nestjs/common';
import { CepService } from './cep.service';
import { CepParamPipe } from './dto/cep-param.dto';
import type { CepResponseDto } from './dto/cep-response.dto';

@Controller('cep')
export class CepController {
  constructor(private readonly service: CepService) {}

  @Get(':cep')
  async getCep(
    @Param('cep', CepParamPipe) cep: string,
  ): Promise<CepResponseDto> {
    return this.service.lookup(cep);
  }
}
