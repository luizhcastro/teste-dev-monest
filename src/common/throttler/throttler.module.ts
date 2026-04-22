import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';
import { CustomThrottlerGuard } from './custom-throttler.guard';
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
