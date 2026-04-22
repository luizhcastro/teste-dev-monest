import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AllProvidersUnavailableError,
  CepApiError,
  RateLimitExceededError,
} from '../../cep/errors/cep.errors';

interface RequestWithCorrelation extends Request {
  correlationId?: string;
}

@Catch()
export class CepExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(CepExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithCorrelation>();
    const res = ctx.getResponse<Response>();
    const correlationId = req.correlationId;

    if (exception instanceof CepApiError) {
      const body: Record<string, unknown> = {
        error: exception.code,
        message: exception.message,
        correlationId,
      };

      if (exception instanceof AllProvidersUnavailableError) {
        body.attempts = exception.attempts;
        res.setHeader('Retry-After', '30');
      }

      if (exception instanceof RateLimitExceededError) {
        res.setHeader('Retry-After', String(exception.retryAfterSeconds));
      }

      res.status(exception.status).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({
        error: 'bad_request',
        message: exception.message,
        correlationId,
      });
      return;
    }

    this.logger.error({ err: exception, correlationId }, 'unhandled exception');
    res.status(500).json({
      error: 'internal_error',
      correlationId,
    });
  }
}
