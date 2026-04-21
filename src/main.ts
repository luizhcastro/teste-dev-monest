import './common/telemetry/otel-setup';

import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { CepExceptionFilter } from './common/filters/cep-exception.filter';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new CepExceptionFilter());

  // Propaga SIGTERM/SIGINT pros hooks do Nest (onModuleDestroy etc).
  // Sem isso, em rolling deploy do k8s o breaker.shutdown() não roda
  // e requests em voo podem ser perdidos.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CEP API')
    .setDescription(
      'API de consulta de CEP com fallback entre providers (ViaCEP, BrasilAPI), circuit breaker por provider, cache LRU e observabilidade OpenTelemetry.',
    )
    .setVersion(process.env.APP_VERSION ?? 'dev')
    .addTag('cep', 'Consulta de CEP')
    .addTag('health', 'Liveness e readiness probes')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port);
  NestLogger.log(`cep-api listening on :${port}`, 'Bootstrap');
  NestLogger.log(`Swagger UI: http://localhost:${port}/docs`, 'Bootstrap');
}

void bootstrap();
