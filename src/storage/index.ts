/**
 * Aggregated entry point for all storage repositories.
 *
 * Each repo wraps a single SQLite table and exposes its own typed CRUD surface.
 * The {@link Repositories} class wires them onto a shared {@link Database},
 * keeping transactional flows (e.g. `cache.put` + `usage.append`) easy to compose.
 */

import type { Database } from 'better-sqlite3';
import { ProviderRepo } from './repos/providers.js';
import { ProviderModelRepo } from './repos/provider-models.js';
import { VirtualModelRepo } from './repos/virtual-models.js';
import { KeyRepo } from './repos/keys.js';
import { BudgetRepo } from './repos/budget.js';
import { EventRepo } from './repos/events.js';
import { ProbeRepo } from './repos/probe.js';
import { UsageRepo } from './repos/usage.js';
import { CacheRepo } from './repos/cache.js';
import { RequestLogRepo } from './repos/request-logs.js';
import { ResponseCacheRepo } from './repos/response-cache.js';

export * from './types.js';
export { ProviderRepo } from './repos/providers.js';
export { ProviderModelRepo } from './repos/provider-models.js';
export { VirtualModelRepo } from './repos/virtual-models.js';
export { KeyRepo } from './repos/keys.js';
export { BudgetRepo } from './repos/budget.js';
export { EventRepo } from './repos/events.js';
export { ProbeRepo } from './repos/probe.js';
export { UsageRepo } from './repos/usage.js';
export { CacheRepo } from './repos/cache.js';
export { RequestLogRepo } from './repos/request-logs.js';
export { ResponseCacheRepo } from './repos/response-cache.js';

export class Repositories {
  readonly providers: ProviderRepo;
  readonly providerModels: ProviderModelRepo;
  readonly virtualModels: VirtualModelRepo;
  readonly keys: KeyRepo;
  readonly budget: BudgetRepo;
  readonly events: EventRepo;
  readonly probes: ProbeRepo;
  readonly usage: UsageRepo;
  readonly cache: CacheRepo;
  readonly requestLogs: RequestLogRepo;
  readonly responseCache: ResponseCacheRepo;

  constructor(private readonly db: Database) {
    this.providers = new ProviderRepo(db);
    this.providerModels = new ProviderModelRepo(db);
    this.virtualModels = new VirtualModelRepo(db);
    this.keys = new KeyRepo(db);
    this.budget = new BudgetRepo(db);
    this.events = new EventRepo(db);
    this.probes = new ProbeRepo(db);
    this.usage = new UsageRepo(db);
    this.cache = new CacheRepo(db);
    this.requestLogs = new RequestLogRepo(db);
    this.responseCache = new ResponseCacheRepo(db);
  }

  /** Run multiple repo operations in a single SQLite transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  raw(): Database {
    return this.db;
  }
}