/**
 * Placeholder de inicialização do OpenTelemetry.
 *
 * Deve ser importado como a PRIMEIRA linha de `main.ts` para que as
 * instrumentações automáticas (http, nestjs) consigam registrar seus hooks
 * antes de qualquer módulo ser carregado.
 *
 * A configuração real (SDK, exporters OTLP, métricas custom) é feita na
 * Fase 6 — Observabilidade.
 */
export {};
