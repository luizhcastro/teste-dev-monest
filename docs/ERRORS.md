# Tratamento de Erros

## Princípio
Cada tipo de falha é uma **classe**. Fluxo decide em `instanceof`, não em strings nem em status codes vagos. Exception filter mapeia pra HTTP apenas na borda.

## Hierarquia

```
CepApiError (abstract)                          [vai pro cliente]
├── InvalidCepError                  [400]
├── CepNotFoundError                 [404]
├── RateLimitExceededError           [429]
└── AllProvidersUnavailableError     [503]

ProviderError (abstract)                        [interno, nunca vaza]
├── ProviderTimeoutError
├── ProviderHttpError
├── ProviderNetworkError
└── ProviderContractError
```

`ProviderError` **nunca** é retornado ao cliente. O service captura, acumula em `attempts`, e ou tenta próximo provider ou converte em `AllProvidersUnavailableError`.

## Tabela de referência rápida

| Erro | Origem | Fallback? | Conta no circuit? | HTTP |
|---|---|---|---|---|
| `InvalidCepError` | DTO (regex falha) | — | — | 400 |
| `CepNotFoundError` | Provider retorna 404 ou `{erro:true}` | **NÃO** | **NÃO** | 404 |
| `RateLimitExceededError` | ThrottlerGuard bloqueou | **NÃO** | — | 429 |
| `ProviderTimeoutError` | AbortSignal disparou | SIM | SIM | (próximo) |
| `ProviderHttpError` | Provider 5xx | SIM | SIM | (próximo) |
| `ProviderNetworkError` | ECONNREFUSED, DNS, reset | SIM | SIM | (próximo) |
| `ProviderContractError` | Zod falhou no payload | SIM | SIM | (próximo) |
| `AllProvidersUnavailableError` | Todos falharam | — | — | 503 |

## Classes

```ts
// src/cep/errors/cep.errors.ts

export abstract class CepApiError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
}

export class InvalidCepError extends CepApiError {
  readonly status = 400;
  readonly code = 'invalid_cep';
  constructor(readonly input: string) {
    super(`Invalid CEP format: ${input}`);
  }
}

export class CepNotFoundError extends CepApiError {
  readonly status = 404;
  readonly code = 'cep_not_found';
  constructor(readonly cep: string) {
    super(`CEP ${cep} not found`);
  }
}

export interface ProviderAttempt {
  provider: string;
  reason: string;
  latencyMs?: number;
}

export class AllProvidersUnavailableError extends CepApiError {
  readonly status = 503;
  readonly code = 'all_providers_unavailable';
  constructor(readonly attempts: ProviderAttempt[]) {
    super('All providers are unavailable');
  }
}

export class RateLimitExceededError extends CepApiError {
  readonly status = 429;
  readonly code = 'rate_limit_exceeded';
  constructor(readonly retryAfterSeconds: number) {
    super('Rate limit exceeded');
  }
}

export abstract class ProviderError extends Error {
  abstract readonly reason: string;
  constructor(readonly provider: string, cause?: unknown) {
    super(`Provider ${provider} failed: ${(cause as Error)?.message ?? 'unknown'}`);
    if (cause) this.cause = cause;
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly reason = 'timeout';
}
export class ProviderHttpError extends ProviderError {
  readonly reason = 'http_error';
  constructor(provider: string, readonly statusCode: number, cause?: unknown) {
    super(provider, cause);
  }
}
export class ProviderNetworkError extends ProviderError {
  readonly reason = 'network_error';
}
export class ProviderContractError extends ProviderError {
  readonly reason = 'contract_error';
}
```

## Exception filter

```ts
// src/common/filters/cep-exception.filter.ts

@Catch()
export class CepExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(CepExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId = (req as any).correlationId;

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

      return res.status(exception.status).json(body);
    }

    // HttpException do Nest (ex: BadRequestException do ValidationPipe)
    if (exception instanceof HttpException) {
      return res.status(exception.getStatus()).json({
        error: 'bad_request',
        message: exception.message,
        correlationId,
      });
    }

    // Inesperado
    this.logger.error(
      { err: exception, correlationId },
      'unhandled exception',
    );
    return res.status(500).json({
      error: 'internal_error',
      correlationId,
    });
  }
}
```

Registro global em `main.ts`:
```ts
app.useGlobalFilters(new CepExceptionFilter());
```

## Response shape por tipo

### 200 OK
```json
{
  "cep": "01310100",
  "street": "Avenida Paulista",
  "neighborhood": "Bela Vista",
  "city": "São Paulo",
  "state": "SP",
  "provider": "brasilapi",
  "cached": false
}
```

### 400 Bad Request
```json
{
  "error": "invalid_cep",
  "message": "Invalid CEP format: abc",
  "correlationId": "uuid-v4"
}
```

### 404 Not Found
```json
{
  "error": "cep_not_found",
  "message": "CEP 00000000 not found",
  "correlationId": "uuid-v4"
}
```

### 429 Too Many Requests
```json
{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded",
  "correlationId": "uuid-v4"
}
```
+ header `Retry-After: <segundos>`. Detalhes em [RATE-LIMIT.md](./RATE-LIMIT.md).

### 503 Service Unavailable
```json
{
  "error": "all_providers_unavailable",
  "message": "All providers are unavailable",
  "correlationId": "uuid-v4",
  "attempts": [
    { "provider": "brasilapi", "reason": "timeout", "latencyMs": 3001 },
    { "provider": "viacep", "reason": "circuit_open" }
  ]
}
```
+ header `Retry-After: 30`.

## Por que não usar HttpException direto?

Classes próprias permitem:
1. **Checar `instanceof` no service** pra decidir fluxo (404 curto-circuita, 5xx continua loop)
2. **Testes desacoplados de framework** (posso testar service sem subir Nest)
3. **Anexar metadados ricos** (`attempts`, `cep`, `reason`, `statusCode`) sem virar any
4. **Reaproveitar em outros entry points** no futuro (gRPC, message queue) sem reescrever

## Discussão: vazar `reason` e `attempts` é ok?

É debatível. Argumentos:
- **Pró**: ajuda clientes decidirem retry; não é dado sensível; ajuda oncall
- **Contra**: expõe arquitetura interna; se um atacante souber que circuito tem `resetTimeout` de 30s pode tentar timing attacks

Neste projeto, **expomos no body**. Alternativa: mover pra header custom (`X-Cep-Attempts`) e deixar só código no body. Decisão tomada: transparência > paranoia, o serviço é público e baixo risco.
