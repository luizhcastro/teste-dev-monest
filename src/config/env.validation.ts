import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  APP_VERSION: z.string().default('dev'),

  VIACEP_URL: z.string().url().default('https://viacep.com.br'),
  BRASILAPI_URL: z.string().url().default('https://brasilapi.com.br'),

  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  CIRCUIT_ERROR_THRESHOLD_PERCENTAGE: z.coerce
    .number()
    .min(1)
    .max(100)
    .default(50),
  CIRCUIT_VOLUME_THRESHOLD: z.coerce.number().int().positive().default(10),
  CIRCUIT_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),
  CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

  OTEL_SERVICE_NAME: z.string().default('cep-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  NEW_RELIC_LICENSE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}
