import path from 'node:path';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';

export interface Config {
  appEnv: AppEnv;
  port: number;
  host: string;
  databaseUrl: string;
  databaseSsl: boolean;
  storageRoot: string;
  storageMinFreeBytes: number;
  maxPhotoBytes: number;
  maxDocumentBytes: number;
  sessionTtlHours: number;
  loginRateLimitPerMinute: number;
  secureCookies: boolean;
  displayTimeZone: string;
  jobsEnabled: boolean;
  webDistDir: string;
  logLevel: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${name}`);
  return v.trim();
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appEnv = (env.APP_ENV ?? 'development') as AppEnv;
  if (!['development', 'test', 'staging', 'production'].includes(appEnv)) {
    throw new Error(`APP_ENV must be development, test, staging or production (got ${appEnv})`);
  }
  const storageRoot = path.resolve(required(env, 'STORAGE_ROOT'));
  if ((appEnv === 'staging' || appEnv === 'production') && (storageRoot.startsWith('/tmp') || storageRoot === '/')) {
    // Evidence must never land on ephemeral container storage.
    throw new Error(`STORAGE_ROOT ${storageRoot} is not an acceptable evidence location for ${appEnv}`);
  }
  const timeZone = env.DISPLAY_TIMEZONE ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`DISPLAY_TIMEZONE ${timeZone} is not a valid IANA time zone`);
  }
  return {
    appEnv,
    port: intEnv(env, 'PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    databaseSsl: env.DATABASE_SSL === 'true',
    storageRoot,
    storageMinFreeBytes: intEnv(env, 'STORAGE_MIN_FREE_MB', 256) * 1024 * 1024,
    maxPhotoBytes: intEnv(env, 'MAX_PHOTO_MB', 15) * 1024 * 1024,
    maxDocumentBytes: intEnv(env, 'MAX_DOCUMENT_MB', 25) * 1024 * 1024,
    sessionTtlHours: intEnv(env, 'SESSION_TTL_HOURS', 12),
    loginRateLimitPerMinute: intEnv(env, 'LOGIN_RATE_LIMIT_PER_MIN', 10),
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : appEnv === 'staging' || appEnv === 'production',
    displayTimeZone: timeZone,
    jobsEnabled: env.JOBS_ENABLED !== 'false',
    webDistDir: path.resolve(env.WEB_DIST_DIR ?? 'dist/web'),
    logLevel: env.LOG_LEVEL ?? (appEnv === 'test' ? 'silent' : 'info'),
  };
}
