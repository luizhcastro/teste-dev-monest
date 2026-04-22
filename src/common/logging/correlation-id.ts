import { randomUUID } from 'node:crypto';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return undefined;

  return UUID_V4_REGEX.test(trimmed) ? trimmed : undefined;
}

export function resolveCorrelationId(value: unknown): string {
  return sanitizeCorrelationId(value) ?? randomUUID();
}
