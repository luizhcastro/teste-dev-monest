import { Module } from '@nestjs/common';
import { CepModule } from './cep/cep.module';
import { ConfigModule } from './config/config.module';

@Module({
  imports: [ConfigModule, CepModule],
})
export class AppModule {}
