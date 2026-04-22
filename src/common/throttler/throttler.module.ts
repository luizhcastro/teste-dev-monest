import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';
import { CustomThrottlerGuard } from './custom-throttler.guard';

// Lemos de process.env diretamente (não ConfigService) pois o cache global do
// ConfigModule compartilha estado entre testes e não reflete mutações tardias.
// A validação/coerção roda em ConfigModule.validate() no boot — se os valores
// forem inválidos, o app não sobe.
@Module({
  imports: [
    NestThrottlerModule.forRootAsync({
      useFactory: () => [
        {
          name: 'default',
          ttl: Number(process.env.RATE_LIMIT_TTL_MS ?? 60_000),
          limit: Number(process.env.RATE_LIMIT_MAX ?? 60),
        },
      ],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: CustomThrottlerGuard }],
})
export class ThrottlerModule {}
