import { Injectable, NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const RESPONSE_HEADER = 'X-Correlation-Id';

export type RequestWithCorrelation = Request & {
  correlationId: string;
  id?: string | number;
};

/**
 * Publica o correlation id:
 * - Fonte preferencial: `req.id` (já atribuído por `pino-http` via genReqId,
 *   que lê `X-Correlation-Id` ou gera UUID)
 * - Fallback: gera UUID (caso pino não esteja configurado)
 *
 * Anexa ao request (`req.correlationId`) e ao span ativo do OTel.
 * O response header é setado pelo próprio pino-http.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const r = req as RequestWithCorrelation;
    const id = (r.id !== undefined ? String(r.id) : undefined) ?? randomUUID();

    r.correlationId = id;
    if (!res.getHeader(RESPONSE_HEADER)) {
      res.setHeader(RESPONSE_HEADER, id);
    }

    const span = trace.getActiveSpan();
    span?.setAttribute('correlation.id', id);

    next();
  }
}
