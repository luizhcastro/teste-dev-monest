import { resolveCorrelationId, sanitizeCorrelationId } from '../../src/common/logging/correlation-id';

describe('correlation-id', () => {
  it('accepts a valid UUID v4', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';

    expect(sanitizeCorrelationId(id)).toBe(id);
    expect(resolveCorrelationId(id)).toBe(id);
  });

  it('rejects non-uuid values', () => {
    expect(sanitizeCorrelationId('test-correlation-abc-123')).toBeUndefined();
  });

  it('rejects values longer than 128 chars', () => {
    expect(sanitizeCorrelationId('a'.repeat(129))).toBeUndefined();
  });

  it('generates a UUID v4 when the header is invalid', () => {
    const resolved = resolveCorrelationId('test-correlation-abc-123');

    expect(resolved).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
