import { Module } from '@nestjs/common';
import { CepModule } from '../cep/cep.module';
import { HealthController } from './health.controller';

@Module({
  imports: [CepModule],
  controllers: [HealthController],
})
export class HealthModule {}
