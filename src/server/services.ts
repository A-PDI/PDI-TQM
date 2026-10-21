import type { Config } from './config.js';
import type { Db } from './db.js';
import type { JobWorker } from './jobs.js';
import type { EvidenceStorage } from './storage.js';

export interface Services {
  db: Db;
  config: Config;
  storage: EvidenceStorage;
  logo: Buffer | null;
  worker: JobWorker | null;
}
