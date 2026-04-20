import './common/telemetry/otel-setup';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { CepExceptionFilter } from './common/filters/cep-exception.filter';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new CepExceptionFilter());

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);
  Logger.log(`cep-api listening on :${port}`, 'Bootstrap');
}

void bootstrap();
