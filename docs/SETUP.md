# Setup

## Requisitos
- Node.js 20+
- npm (ou pnpm/yarn)
- Docker (opcional)

## Variáveis de ambiente

`.env.example`:
```bash
# App
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
APP_VERSION=dev

# Providers
VIACEP_URL=https://viacep.com.br
BRASILAPI_URL=https://brasilapi.com.br

# Resiliência
PROVIDER_TIMEOUT_MS=3000
CIRCUIT_ERROR_THRESHOLD_PERCENTAGE=50
CIRCUIT_VOLUME_THRESHOLD=10
CIRCUIT_RESET_TIMEOUT_MS=30000

# Cache
CACHE_MAX_ENTRIES=10000
CACHE_TTL_MS=86400000

# Observabilidade (opcional em dev)
OTEL_SERVICE_NAME=cep-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net:4318
NEW_RELIC_LICENSE_KEY=
```

### Validação com Zod

`src/config/env.validation.ts`:
```ts
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  VIACEP_URL: z.string().url().default('https://viacep.com.br'),
  BRASILAPI_URL: z.string().url().default('https://brasilapi.com.br'),

  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  CIRCUIT_ERROR_THRESHOLD_PERCENTAGE: z.coerce.number().min(1).max(100).default(50),
  CIRCUIT_VOLUME_THRESHOLD: z.coerce.number().int().positive().default(10),
  CIRCUIT_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),
  CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  OTEL_SERVICE_NAME: z.string().default('cep-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  NEW_RELIC_LICENSE_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
```

Processo **não sobe** com env inválido — fail fast.

## Rodar local

```bash
npm install
cp .env.example .env
npm run start:dev
```

Teste:
```bash
curl -s http://localhost:3000/cep/01310100 | jq
```

## Docker

`Dockerfile` (multi-stage):
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`docker-compose.yml`:
```yaml
services:
  api:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health/live"]
      interval: 30s
      timeout: 3s
      retries: 3
```

```bash
docker compose up --build
```

## Scripts (package.json)

```json
{
  "scripts": {
    "start": "node dist/main",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "build": "nest build",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:e2e": "jest --config test/jest-e2e.json",
    "lint": "eslint \"{src,test}/**/*.ts\" --fix",
    "format": "prettier --write \"{src,test}/**/*.ts\""
  }
}
```

## Health checks

Dois endpoints, seguindo convenção k8s:

### `GET /health/live` — liveness
Retorna 200 sempre que o processo está de pé. Usado pra k8s decidir restart.

```ts
@Get('live')
live() {
  return { status: 'ok' };
}
```

### `GET /health/ready` — readiness
Retorna 200 se **pelo menos um circuito** está CLOSED ou HALF_OPEN. Se ambos OPEN → 503.

```ts
@Get('ready')
ready() {
  const breakers = this.breakerFactory.all();
  const anyUp = breakers.some(b => !b.opened);
  if (!anyUp) {
    throw new ServiceUnavailableException({
      status: 'not_ready',
      circuits: breakers.map(b => ({
        provider: b.name,
        state: b.opened ? 'open' : 'closed',
      })),
    });
  }
  return { status: 'ready', circuits: /* ... */ };
}
```

Em k8s: liveness separado de readiness permite que o pod **não receba tráfego** quando está degradado, sem ser reiniciado.

## Makefile (conveniência)

```makefile
.PHONY: install dev build test lint docker clean

install:
	npm install

dev:
	npm run start:dev

build:
	npm run build

test:
	npm test

test-e2e:
	npm run test:e2e

lint:
	npm run lint

docker:
	docker compose up --build

clean:
	rm -rf dist node_modules coverage
```

`make dev` ou `make docker` pra rodar.

## Teste manual rápido

```bash
# CEP válido
curl -s http://localhost:3000/cep/01310100 | jq

# Com hífen (deve normalizar)
curl -s http://localhost:3000/cep/01310-100 | jq

# CEP inválido (formato)
curl -i http://localhost:3000/cep/abc

# CEP inexistente
curl -i http://localhost:3000/cep/00000000

# Health
curl -s http://localhost:3000/health/live
curl -s http://localhost:3000/health/ready | jq

# Forçar correlation id
curl -sH 'X-Correlation-Id: my-id' http://localhost:3000/cep/01310100
```

## Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| App sobe mas não exporta pro NR | `NEW_RELIC_LICENSE_KEY` vazio | Checar `.env` |
| `503` logo após subir | Ambos providers retornaram erro e circuitos abriram | Checar conectividade outbound |
| Validação de env falha | Zod schema | Mensagem do Zod mostra qual var falhou |
| Timeout consistente | Firewall bloqueia outbound 443 | Liberar firewall ou rodar com mock |
