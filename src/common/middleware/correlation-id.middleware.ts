import { Injectable, NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { resolveCorrelationId } from '../logging/correlation-id';

const RESPONSE_HEADER = 'X-Correlation-Id';

export type RequestWithCorrelation = Request & {
  correlationId: string;
  id?: string | number;
};

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const r = req as RequestWithCorrelation;
    const id = resolveCorrelationId(r.id);

    r.correlationId = id;
    if (!res.getHeader(RESPONSE_HEADER)) {
      res.setHeader(RESPONSE_HEADER, id);
    }

    const span = trace.getActiveSpan();
    span?.setAttribute('correlation.id', id);

    next();
  }
}
