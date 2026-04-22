import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { RateLimitExceededError } from '../../cep/errors/cep.errors';
import { rateLimitExceededTotal } from '../telemetry/tracer';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: {
    ips?: string[];
    ip?: string;
    socket?: { remoteAddress?: string };
  }): Promise<string> {
    if (req.ips?.length) return req.ips[0];
    if (req.ip) return req.ip;
    return req.socket?.remoteAddress ?? 'unknown';
  }

  protected async throwThrottlingException(
    _context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(throttlerLimitDetail.timeToBlockExpire),
    );
    rateLimitExceededTotal.add(1);
    throw new RateLimitExceededError(retryAfterSeconds);
  }
}
