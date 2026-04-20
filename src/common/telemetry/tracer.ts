import { metrics, trace } from '@opentelemetry/api';

export const tracer = trace.getTracer('cep-api');

const meter = metrics.getMeter('cep-api');

export const cepLookupTotal = meter.createCounter('cep_lookup_total', {
  description: 'Total de lookups de CEP',
});

export const cepLookupDuration = meter.createHistogram(
  'cep_lookup_duration_seconds',
  {
    description: 'Duração do lookup de CEP',
    unit: 's',
  },
);

export const providerRequestsTotal = meter.createCounter(
  'cep_provider_requests_total',
  {
    description: 'Requests feitos a cada provider',
  },
);

export const providerDuration = meter.createHistogram(
  'cep_provider_duration_seconds',
  {
    description: 'Duração das chamadas aos providers',
    unit: 's',
  },
);

export const circuitStateGauge = meter.createObservableGauge(
  'cep_circuit_state',
  {
    description: 'Estado do circuito: 0=closed, 1=half-open, 2=open',
  },
);

export const cacheHitsTotal = meter.createCounter('cep_cache_hits_total', {
  description: 'Cache hits (inclui stale)',
});

export const cacheMissesTotal = meter.createCounter('cep_cache_misses_total', {
  description: 'Cache misses',
});

export const cacheStaleHitsTotal = meter.createCounter(
  'cep_cache_stale_hits_total',
  {
    description: 'Cache hits que foram stale (usados no fallback 503)',
  },
);
