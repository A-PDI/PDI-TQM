# PDI TQMS — Total Quality Management System

Internal quality-management web application for PDI: receiving inspections, quality concerns and NCRs with containment and disposition, concessions, SCARs, supplier commitments, parts/sources/suppliers with A/B/C sourcing, change control, controlled forms, injector bench testing and repair, management reports and traceability.

One TypeScript modular monolith: React web app + Fastify (Node 22) API, PostgreSQL as the source of truth, a private persistent disk for original files and generated PDFs, and a database-backed job queue. Designed to run as a single Render web service.

**Status: Stages 0–5 (foundation, receiving inspection, supplier qualification and sourcing, NCR/concession/SCAR, supplier commitments, change control, the form editor, injector tests/repairs with an interim synthetic bench-file adapter, management reports/exports and traceability, plus the Stage 5 finishes: full-route authorization sweep, adversarial and concurrency tests, verified backup/restore, accessibility audit, visual baselines and volume performance checks).** Not production-ready; see [docs/DESIGN_BASELINE.md](docs/DESIGN_BASELINE.md) for what is built, what is not, and the business decisions PDI must sign.

## Local development

Prerequisites: Node 22.12+, PostgreSQL 16 or 17 with `pg_dump`/`pg_restore` of the same major version as the server (backup tests), `pdftotext`/`pdfinfo`/`pdftoppm` (poppler-utils) for the PDF tests, and `fonts-liberation` + `fonts-freefont-ttf` for the visual baselines.

```bash
npm ci
cp .env.example .env            # then edit DATABASE_URL; load it into your shell
export $(grep -v '^#' .env | xargs)

npm run migrate                 # forward-only migrations + reference data (forms, capabilities, policy register)
npm run storage:init            # one-time: marks the evidence folder as an initialized volume
TQMS_DEMO_PASSWORD='choose-12+-chars' npm run seed:demo   # optional FICTIONAL demo users/parts/suppliers

npm run dev:server              # API on :3000
npm run dev:web                 # web on :5173 (proxies /api to :3000)
```

Demo users (fictional, all share `TQMS_DEMO_PASSWORD`): `jordan.rivera@example.com` (inspector), `casey.morgan@example.com` (quality), `taylor.brooks@example.com` (engineering), `riley.chen@example.com` (management + inspector), `avery.patel@example.com` (administrator), `morgan.diaz@example.com` (purchasing).

For a real environment, do not seed demo data. Create the first administrator once:

```bash
TQMS_BOOTSTRAP_PASSWORD='…' npm run bootstrap:admin -- --email admin@pdi.example --name "Name"
```

## Checks

```bash
npm run typecheck
npm run lint
npm test                        # unit + API integration + PDF tests (needs TEST_DATABASE_URL)
npm run build && npm run test:e2e   # Playwright desktop (1440), phone (390) and visual-baseline projects (needs an e2e database)
PERF_SCALE=5 npx vitest run tests/integration/performance.test.ts   # optional: ~15 years of fictional volume
```

- Visual baselines live in `tests/e2e/*-snapshots/` and render with the pinned fonts in `tests/fixtures/fonts.conf`. After an intended UI or report change: `npm test`, `npx tsx scripts/capture-pdf-fixtures.ts`, then `npx playwright test --project=visual --update-snapshots`, and review the image diffs before committing.

- `TEST_DATABASE_URL` (default `postgres://tqms:tqms_local_dev@localhost:5432/tqms_test`) is **dropped and recreated** by the tests.
- `E2E_DATABASE_URL` (default `…/tqms_e2e`) is reset by `scripts/e2e-server.sh`.
- Sample PDFs land in `var/report-samples/`, screenshots in `var/screenshots/`.

## Backup and restore verification

```bash
npm run backup:create -- --out /path/to/backups      # database + evidence files, one consistent snapshot
npm run backup:verify -- --from /path/to/backups/<id> # restores into a NEW isolated database and folder, validates, then removes them
```

Use `pg_dump`/`pg_restore` of the same major version as the server (the production image ships PostgreSQL 17 client tools); a dump can only be restored into a server at least as new as the tools that wrote it, and `backup:verify` reports a mismatch instead of attempting it. The tools are taken from `PG_BIN_DIR` when set, otherwise from `/usr/lib/postgresql/<server major>/bin` when present (Debian/Ubuntu), otherwise from `PATH`. `backup:create` uses `DATABASE_URL` and `STORAGE_ROOT`; `backup:verify` creates its scratch database on the server in `DATABASE_URL` (needs CREATEDB) and exits 0 only when every check passes (anything else is INCOMPLETE). Copying backups to an encrypted off-site destination, the schedule and the RPO/RTO are PDI decisions (POL-09). In the production image use `backup:create:prod` / `backup:verify:prod`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `APP_ENV` | yes | `development`, `test`, `staging` or `production` |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DATABASE_SSL` | no | `true` to require TLS to the database |
| `STORAGE_ROOT` | yes | Evidence disk mount (e.g. `/app/data`); `/tmp` is refused in staging/production |
| `STORAGE_MIN_FREE_MB` | no | Readiness fails below this free space (default 256) |
| `MAX_PHOTO_MB` | no | Photo upload limit (default 15) |
| `SESSION_TTL_HOURS` | no | Session lifetime (default 12) |
| `LOGIN_RATE_LIMIT_PER_MIN` | no | Sign-in attempts per IP per minute (default 10) |
| `MAX_DOCUMENT_MB` | no | Document evidence upload limit (default 25) |
| `SECURE_COOKIES` | no | Defaults to `true` in staging/production |
| `DISPLAY_TIMEZONE` | no | IANA zone for report dates (default `UTC`; POL-16) |
| `JOBS_ENABLED` | no | `false` disables the in-process job worker |
| `PORT`, `HOST`, `LOG_LEVEL` | no | Server settings |

## Deployment (Render)

`render.yaml` is a **template** for an isolated staging environment; nothing has been provisioned. Applying it creates paid resources and needs PDI owner approval. Order on a new environment:

1. Build: Docker image from `Dockerfile`.
2. Pre-deploy: `node dist/server/server/cli/migrate.js` (migrations + reference data).
3. Once per new disk: `node dist/server/server/cli/storage-init.js` (Render shell). Until this runs, `/health/ready` reports the disk as not initialized; the app never writes evidence to the container image.
4. Once per environment: bootstrap the administrator.

`/health/ready` fails if the database is unreachable, the evidence disk is absent, unwritable or nearly full, or the disk does not belong to this database.

## Repository layout

```
src/shared/     domain rules shared by server and browser (forms, measurement, completion, sourcing, quality/change rules, bench CSV, metric definitions)
src/server/     Fastify API, auth, audit, storage, jobs, PDF rendering, CLIs
src/web/        React application
migrations/     forward-only SQL migrations
seed/forms/     Appendix A form catalogue (generated by `npm run catalogue:import`)
docs/           requirements, construction drawings and the design baseline
tests/          unit, integration (API + PDF) and Playwright e2e tests
```

Confidential reference reports are **not** in this repository and must not be added. All test data and images are fabricated.
