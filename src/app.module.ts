import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CepModule } from './cep/cep.module';
import { LoggerModule } from './common/logging/logger.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, LoggerModule, CepModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
