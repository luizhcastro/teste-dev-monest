import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.validation';

const CORRELATION_HEADER_LOWER = 'x-correlation-id';
const CORRELATION_HEADER_RESPONSE = 'X-Correlation-Id';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const level = config.get('LOG_LEVEL', { infer: true }) as string;
        const isDev =
          config.get('NODE_ENV', { infer: true }) === 'development';
        const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        const serviceName = process.env.OTEL_SERVICE_NAME ?? 'cep-api';
        const serviceVersion = process.env.APP_VERSION ?? 'dev';

        const prodTransport = otlpEndpoint
          ? {
              target: 'pino-opentelemetry-transport',
              options: {
                loggerName: serviceName,
                serviceVersion,
                resourceAttributes: {
                  'service.name': serviceName,
                  'service.version': serviceVersion,
                },
              },
            }
          : undefined;

        return {
          pinoHttp: {
            level,
            transport: isDev
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req.headers,res.headers',
                  },
                }
              : prodTransport,

            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const incoming = req.headers[CORRELATION_HEADER_LOWER];
              const id =
                (typeof incoming === 'string' && incoming.trim()) ||
                randomUUID();
              res.setHeader(CORRELATION_HEADER_RESPONSE, id);
              return id;
            },

            customProps: (req: IncomingMessage) => ({
              correlationId: (req as IncomingMessage & { id?: string }).id,
            }),

            mixin: () => {
              const span = trace.getActiveSpan();
              if (!span) return {};
              const ctx = span.spanContext();
              return { traceId: ctx.traceId, spanId: ctx.spanId };
            },

            serializers: {
              req: (req: IncomingMessage & { id?: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
              }),
              res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
            },

            customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
              `${req.method} ${req.url} ${res.statusCode}`,
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
