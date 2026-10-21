# TQMS design baseline and Stage 0–1 milestone

Source: *PDI TQMS Zero-to-Production Construction Set* (20 Oct 2026). The authoritative requirements are copied verbatim in [`requirements/`](requirements) and the construction drawings in [`construction/`](construction). This file covers items (a)–(e) of the master prompt's Part XI response contract.

Status vocabulary (Drawing F1): **implemented** → **unit-tested** → **integration-tested** → **UI-tested** → **staging-tested** → **PDI-approved** → **production-released**. Nothing here is beyond UI-tested. Nothing has been deployed to Render, and no real data has been used.

## (a) Implementation plan mapped to P0 and acceptance tests

| Stage | Scope | AT cases | State |
|---|---|---|---|
| 0 Foundation | identity, grants, sessions, CSRF, audit, numbering, evidence disk, jobs, migrations, health/readiness, Docker | AT-19 (part), AT-21 (part), NEG-10/11/12/13/14* | **Built in this PR** (*NEG-14 needs backup tooling, Stage 6) |
| 1 Inspector's room | Appendix A catalogue, launch, multi-unit workbench, all specialized patterns, photos, partial/complete, independent review, amendments, branded PDF, linked concern + triage | AT-01, AT-02 (part), AT-03 (part), AT-04, AT-06 (part) | **Built in this PR** |
| 2 Supplier/engineering | site qualification, A/B/C sourcing, baseline release workflow and UI, FAI reject/resubmit, supplier acknowledgment, source approval with frozen manifest | AT-07–AT-13, AT-17 | Not started |
| 3 Quality/change | NCR scope/containment/disposition, concession, SCAR/8D/effectiveness/recurrence, change control, form-revision editor, ENG/OPS PDFs | AT-02, AT-03, AT-06, AT-08, AT-14–AT-16, AT-18 | Not started |
| 4 Injector & management | serialized tests/repairs, import adapters, comparison reports, dashboards/reports, exports | AT-05, AT-20 | Not started |
| 5 Finishes | all 21 AT + adversarial cases, visual regression baselines, accessibility audit, performance | all | Not started |
| 6 Inspection & occupancy | Render staging, PG + disk backup/restore drill, PDI sign-off, production go/no-go | AT-21 (restore), NEG-14 | Not started; needs owner approval |

## (b) Technology choices

All versions are pinned exactly (`package.json`), are at least two weeks old, and pass `npm audit` with 0 vulnerabilities.

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript 5.9 | Required stack; LTS line |
| HTTP | Fastify 5 + `@fastify/cookie`, `helmet`, `rate-limit`, `multipart`, `static` | Mature, small, streaming multipart for photos |
| Database | PostgreSQL 17 on Render (16 locally) via `pg` | Plain SQL; integrity in migrations and triggers rather than an ORM |
| Validation | `zod` 3 | One schema language for API input and form definitions |
| Passwords | Node `crypto.scrypt` (N=2^15) | No native dependency |
| PDF | `pdfkit` | Pure JS, drawn from structured snapshots, no browser in the image |
| Image checks | `image-size` (header-only) + signature sniffing | Rejects disguised files and oversized dimensions without decoding |
| Web | React 19, React Router 7, Vite 7, plain CSS tokens | No UI framework lock-in; compact density |
| Tests | Vitest 4 (unit/API/PDF on a real database), Playwright 1.56 | Real DB and real browser, no mocks |

Not used, as the spec requires: S3/object store, Redis, queues/brokers, search clusters, external auth, microservices. Storage sits behind `EvidenceStorage` so it could move to object storage later.

## (c) Policy and open-evidence register

Seeded into the `policy_decision` table and shown in the app (*Policy register*). Every item is **POLICY OPEN**. Open items do not block synthetic staging work; they do block consequential production use.

| Code | Decision PDI must sign | Interim behavior in the software |
|---|---|---|
| POL-01 | Authority grants and independence exceptions | Capabilities granted per person; a reviewer must not be the inspector; no exception path |
| POL-02 | Acceptance limits, units, methods, CTQ, effectivity | Without a released baseline limit, readings are observations and need Engineering review; no PASS is calculated |
| POL-03 | Sampling/AQL, lot handling, release with missing baseline | Sample size is entered by hand; completing an inspection never releases material |
| POL-04 | Risk method, assessment/FAI/PPAP triggers, SCAR/suspension criteria | Not used yet |
| POL-05 | Concessions, containment, partial release, physical verification | Material always shown as *not authorized* |
| POL-06 | Change effectivity, old lots, requalification | Not used yet |
| POL-07 | Signature format, brand artwork/fonts/colors, numbering, retention | Reference logo extract + suggested navy tokens; `IR-`/`QE-YYYY-NNNNN`; nothing destructively deleted |
| POL-08 | Injector bench formats and rules | Not built |
| POL-09 | Render budget/sizing, monitoring owner, RPO/RTO, off-site backup, MFA, launch gate | Local + template only; nothing provisioned |
| POL-10 | Whether historical sample reports/photos may be imported | Nothing imported; all fixtures fabricated |
| POL-11 | Authority/timing for Accepted results (FR-050) | Requires reviewer holding `inspection.review_accepted` |
| POL-12 | Validation of Appendix A form texts/revisions | Loaded as released, marked "PDI owner validation pending" |
| POL-13 | Suspension propagation (FR-022) | Not used yet |
| POL-14 | NCR closure with open SCAR (FR-075) | Not used yet |
| POL-15 | Retention schedule (FR-095) | Retain everything |
| POL-16 | Display time zone | `DISPLAY_TIMEZONE` setting |

## Design decisions and resolved contradictions

1. **Storage.** The older S3 proposal is superseded by the construction set's Render disk (authority order rule 1). Files are written to staging → fsync → atomic link into an immutable object tree; metadata is committed after the durable write; objects are addressed by random UUID keys. A volume marker plus a database pairing check means an unmounted or mismatched disk fails readiness instead of silently using ephemeral storage.
2. **Legacy "Computed: None" (Appendix A A2).** Treated as a defect, as Part VIII instructs. With a released limit, readings are compared exactly (BigInt decimals, never float-rounded); a value outside the limit cannot be recorded as Pass. Without a released limit, entry is allowed, the row shows "Specification not released — Engineering review required", and completion goes to review instead of a calculated PASS (NEG-16).
3. **Form text vs released limits.** Specifications printed on forms (e.g. groove depth .029–.031") are displayed as *reference text*, never as limits. Only released technical-baseline characteristics (linked by `form_row_ref`) govern.
4. **N/A outside the receiving checklist.** Appendix A lists P/F/A for item rows, but several rows are conditional ("two-piece only", "combination bearings only"). N/A is allowed on every row and needs a reason outside the receiving checklist, so it is never a silent skip (NEG-24).
5. **Unit and overall outcomes** are derived, never typed: worst of FAIL > ACCEPTED > PASS across the shared receiving section and every item. Inspection outcome, review status and material authorization are separate fields and are labelled separately on screen and in the PDF.
6. **Review routing.** Completion goes straight to COMPLETED only when everything passes against released limits. FAIL, ACCEPTED, or unreleased-limit readings go to READY_FOR_REVIEW, locked, until a different person with `inspection.review` confirms it or returns it with a reason. Accepted results also need `inspection.review_accepted`.
7. **Immutability is enforced by database triggers**, not only by the service layer. Covered: released form and baseline revisions, completed inspections and their entries, available files, report snapshots and renditions, reviews, amendments, and the append-only audit table. Corrections are amendment layers (`amendment_no > 0`) that produce a new report edition; earlier editions stay downloadable with their original hash.
8. **Reports** are rendered by a background job from a frozen JSON snapshot (canonical-JSON SHA-256). Photo bytes are hash-verified when rendered. A job abandoned by a crashed worker is reclaimed, and rendering is idempotent per snapshot.
9. **Unbuilt destinations** (Injectors, Changes, Reports) are shown disabled with their stage label, not as dead links. Formal NCR, disposition and SCAR are also clearly marked as Stage 3.

## (d) Acceptance matrix (current state)

Test files: `U` = `tests/unit/domain.test.ts`, `I` = `tests/integration/inspection.test.ts`, `R` = `tests/integration/reports.test.ts`, `E` = `tests/e2e/inspection.spec.ts`.

| Case | State | Evidence |
|---|---|---|
| AT-01 receiving multi-item | UI-tested | I "AT-01…", E "AT-01 inspector walkthrough", U completion rules |
| AT-02 accepted item | Integration-tested (review authority only; concession record is Stage 3) | I "AT-02…", R crankshaft |
| AT-03 template history | Integration-tested (released via SQL; editor UI is Stage 3) | I "form revision history", I "NEG-02…" amendment |
| AT-04 special measurements | Integration + PDF tested | R six-cylinder head, I/U ring end-gap limits, U vacuum/valve rules |
| AT-05 injector | Not built | — |
| AT-06 concern → NCR | Partial: concern from row with evidence + triage; NCR/disposition/closure Stage 3 | I "quality concern linkage" |
| AT-07 – AT-18 | Not built | — |
| AT-19 roles | Partial | I "NEG-19", "NEG-01 style", self-grant denial |
| AT-20 traceability | Partial: search by part/alias/PO/lot/serial/record | API `/api/search`, part/supplier hubs |
| AT-21 failure recovery | Partial: unsaved-entry restore, upload failure message, report-job reclaim, redeploy persistence; **backup/restore not built** | E "AT-21", I "report job recovery", Docker redeploy check |
| NEG-01 | Integration-tested (review/grant APIs; disposition API doesn't exist yet) | I |
| NEG-02, NEG-03 | Integration-tested | I |
| NEG-10, NEG-11, NEG-12 | Integration-tested (NEG-12 also in Docker) | I, U |
| NEG-13 | Manually verified in Docker (container replaced; PDF/photo hashes and draft unchanged) | milestone report |
| NEG-15 | UI-tested (390 px, 100 items) | E phone test |
| NEG-16, NEG-23, NEG-24 | Integration + unit tested | I, U |
| NEG-18 | Integration-tested (no generic close endpoint) | I |
| NEG-19 | Integration-tested | I |
| NEG-20 | By construction: no reference reports or photos in repo/fixtures | `tests/fixtures/images.ts` |
| NEG-21 | UI-tested for built navigation | E navigation test |
| NEG-04–09, 14, 17, 22 | Not built (Stages 2–4, 6) | — |

### Functional requirement traceability (Stage 1 scope)

| FR | Where |
|---|---|
| FR-001, FR-111, FR-112 | `src/shared/capabilities.ts`, `src/server/auth.ts`, `audit.ts`, migration 0001 |
| FR-040, FR-041 | `src/web/pages/Inspections.tsx`, `POST /api/inspections` |
| FR-042 | Released catalogue only; template editor and one-off builder are **Stage 3** |
| FR-043 – FR-051 | `src/web/pages/Workbench.tsx`, `src/shared/inspection.ts`, `src/server/inspections/service.ts` |
| FR-052, FR-053 | `src/server/pdf/inspection-report.ts`, `report-snapshot.ts`, `report-job.ts` |
| FR-054 | `POST /api/inspections/:id/concerns` (`src/server/quality.ts`) |
| FR-055 | form/baseline snapshots + triggers (migration 0003) |
| FR-056 | list status counts share one query definition with the filters |
| FR-011, FR-012, FR-100, FR-101 | `/api/home`, `/api/search`, `QuickCapture.tsx` |
| FR-110 | local accounts, lockout, session revocation; invitation/reset email deferred (email disabled until approved) |
| FR-113 – FR-115 | storage, job worker, readiness, Docker, CI; backup/restore deferred to Stage 6 |

## (e) First vertical transaction (delivered)

An inspector searches a part (including by OE alias) and launches the suggested released form against an exact source. They answer the shared receiving section once, complete serialized items with checklist answers, measurements (compared against the released synthetic baseline) and row photos, then save, reload and resume. Completion is blocked with exact-path messages until required evidence is present. A failed result goes to an independent reviewer; confirmation freezes the record and a background job renders the branded PDF edition with a stored SHA-256. An authorized amendment adds a new edition and leaves the original untouched. A concern raised from a failed row carries the identity, expected/actual values and the *same* photo files into the quality queue for triage by someone other than the reporter.
