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

# Rate limit (per IP, in-memory por instância)
RATE_LIMIT_TTL_MS=60000
RATE_LIMIT_MAX=60

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

  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),

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

`Dockerfile` — multi-stage com 3 estágios (deps / build / runtime) + `tini`:

```dockerfile
# syntax=docker/dockerfile:1.7

# -------- deps (só produção) --------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# -------- build (devDeps + compila TS) --------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# -------- runtime --------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini: reaper de zumbis + forwarding correto de SIGTERM
#       (garante que o handler do OTel rode antes do processo morrer)
RUN apk add --no-cache tini wget

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
```

**Por que 3 estágios:**
- `deps` — node_modules **sem** devDependencies (lean, copiado para runtime)
- `build` — node_modules completo pra compilar TypeScript (descartado depois)
- `runtime` — apenas `dist/` + `node_modules` de produção + binários mínimos

Resultado: imagem final sem `typescript`, `nest-cli`, `jest`, etc.

**Por que `tini`:** Node como PID 1 em container não faz reap de zumbis nem propaga SIGTERM corretamente. `tini` resolve ambos e garante que o `shutdown()` do OTel SDK rode antes do exit.

`docker-compose.yml`:
```yaml
services:
  api:
    build: { context: ., dockerfile: Dockerfile }
    image: cep-api:local
    container_name: cep-api
    ports: ["3000:3000"]
    env_file: [.env]
    environment:
      NODE_ENV: production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health/live"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options: { max-size: "10m", max-file: "3" }
```

```bash
docker compose up --build
# ou
make docker
```

## Scripts (package.json)

```json
{
  "scripts": {
    "prebuild": "rimraf dist",
    "build": "nest build",
    "start": "node dist/main",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main",
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
ready(): ReadyResponse {
  const circuits = this.breakerFactory.all().map(({ name, breaker }) => ({
    provider: name,
    state: this.stateOf(breaker.opened, breaker.halfOpen),
  }));
  const anyUp = circuits.length === 0 || circuits.some((c) => c.state !== 'open');
  if (!anyUp) {
    throw new ServiceUnavailableException({ status: 'not_ready', circuits });
  }
  return { status: 'ready', circuits };
}
```

Se **ainda não houve nenhuma chamada** (factory vazia), readiness retorna `ready` — não temos motivo pra marcar não-pronto antes do primeiro request.

Em k8s: liveness separado de readiness permite que o pod **não receba tráfego** quando está degradado, sem ser reiniciado.

## Makefile (conveniência)

```makefile
.PHONY: install dev build start test test-watch test-cov test-e2e test-all \
        lint format docker docker-build docker-up docker-down clean

install:      ; npm install
dev:          ; npm run start:dev
build:        ; npm run build
start: build  ; npm run start:prod
test:         ; npm test
test-watch:   ; npm run test:watch
test-cov:     ; npm run test:cov
test-e2e:     ; npm run test:e2e
test-all: test test-e2e
lint:         ; npm run lint
format:       ; npm run format
docker-build: ; docker compose build
docker-up:    ; docker compose up -d
docker-down:  ; docker compose down
docker:       ; docker compose up --build
clean:        ; rm -rf dist node_modules coverage
```

`make dev` pra desenvolvimento com hot reload, `make docker` pra subir em container, `make test-all` pra rodar unit + integration + e2e.

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

# Rate limit — com RATE_LIMIT_MAX=3 dispara 429 no 4º hit
for i in 1 2 3 4; do curl -i -s http://localhost:3000/cep/01310100 | head -1; done
```

## Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| App sobe mas não exporta pro NR | `NEW_RELIC_LICENSE_KEY` vazio | Checar `.env` |
| `503` logo após subir | Ambos providers retornaram erro e circuitos abriram | Checar conectividade outbound |
| Validação de env falha | Zod schema | Mensagem do Zod mostra qual var falhou |
| Timeout consistente | Firewall bloqueia outbound 443 | Liberar firewall ou rodar com mock |
