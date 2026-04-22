import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';
import type { Env } from '../../config/env.validation';
import type { CepData } from '../providers/cep-provider.interface';

export interface CachedCepData extends CepData {
  provider: string;
}

export interface CacheLookup {
  data: CachedCepData;
  stale: boolean;
}

@Injectable()
export class CepCacheService {
  private readonly cache: LRUCache<string, CachedCepData>;

  constructor(
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.cache = new LRUCache<string, CachedCepData>({
      max: config.get('CACHE_MAX_ENTRIES', { infer: true }) as number,
      ttl: config.get('CACHE_TTL_MS', { infer: true }) as number,
      ttlAutopurge: false,
      allowStale: true,
      updateAgeOnGet: false,
      ttlResolution: 60_000,
    });
  }

  get(cep: string): CacheLookup | undefined {
    if (this.cache.getRemainingTTL(cep) > 0) {
      const fresh = this.cache.get(cep);
      if (fresh !== undefined) {
        return { data: fresh, stale: false };
      }
    }

    const stale = this.cache.get(cep, { allowStale: true });
    if (stale !== undefined) {
      return { data: stale, stale: true };
    }

    return undefined;
  }

  set(cep: string, data: CachedCepData): void {
    this.cache.set(cep, data);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
