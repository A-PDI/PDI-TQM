# TQM test environment (Render) — pilot

A dedicated environment where one person can click through every module end to end. Everything in it is fictional. It is **not** a production system: no production claims are made for it, and nothing released in it is a production release of a controlled document.

## What it is and what it is separate from

| Resource (Blueprint `render-test.yaml`) | Name | Notes |
|---|---|---|
| Render project / environment | `pdi-tqm-test` / `test` | Its own project; shares nothing with other services |
| Web service | `tqm-test` | Docker image from `./Dockerfile`; **auto-deploys every commit on `main`** |
| PostgreSQL 17 | `tqm-test-db` | Own database (`tqm_test`); no external connections |
| Persistent disk | `tqm-test-documents` (2 GB at `/app/data`) | Own document and PDF storage |

It does not use, read or copy:

- the existing QMS services and their data (`pdi-inspection*`);
- the TQM staging environment (`tqms-staging`, `render.yaml`);
- any future production TQM environment.

Production must be created separately, with its own database, disk and credentials, and never from this environment. The web page shows a **TEST** badge.

## Environment variables

| Variable | Test value | Required | Purpose |
|---|---|---|---|
| `APP_ENV` | `staging` | yes | Deployed non-production runtime: secure cookies, proxy-aware; refuses ephemeral storage |
| `ENVIRONMENT_LABEL` | `TEST` | no | Badge text beside the app name (ignored in production) |
| `DATABASE_URL` | from `tqm-test-db` | yes | Test database only |
| `STORAGE_ROOT` | `/app/data` | yes | The test disk; the app never falls back to container storage |
| `DISPLAY_TIMEZONE` | `America/Chicago` | no (UTC) | Dates on records and PDFs |
| `SECURE_COOKIES` | `true` | no | HTTPS-only session cookie |
| `TQMS_DEMO_PASSWORD` | entered at approval (`sync: false`), 12+ characters | yes here | Password of the fictional personas below; never committed |
| `PILOT_SEED` | `true` | no | Loads the pilot sample records once at start (refused in production) |
| `PILOT_TEMPLATES_DIR` | unset | no | Folder of approved template copies to import before seeding |
| `CARBONZAPP_API_KEY` | **unset** | no | Left unset so the test system never calls the real bench cloud; bench sync shows "not configured" |
| `PORT`, `LOG_LEVEL`, `JOBS_ENABLED`, `LOGIN_RATE_LIMIT_PER_MIN`, `SESSION_TTL_HOURS`, `MAX_PHOTO_MB`, `MAX_DOCUMENT_MB`, `STORAGE_MIN_FREE_MB` | defaults | no | See `src/server/config.ts` |

## First-time setup

1. **Create the Blueprint** from `render-test.yaml`, review the plan and approve it. Enter `TQMS_DEMO_PASSWORD` when asked. The pre-deploy step migrates the database and creates the fictional personas, suppliers, parts and sources.
2. **Import the controlled templates.** Sign in as Avery Patel (administrator), open **Documents → Import documents**, and select copies of the approved set:
   - the files from PDI's *QualitySystemForms* Drive folder (forms and continuation sheets, Rev 03);
   - `PDI_Narrative_Continuation_Rev03.pdf`.

   These are copies released in the test environment only.
3. **Load the pilot records.** Either:
   - restart the service (Render → *Manual Deploy* → *Restart*; `PILOT_SEED` runs at start), or
   - run `npm run seed:pilot:prod` in the service Shell.

   The seed runs once (`system_setting.pilot_seed`) and waits, without creating records, while the forms are not in force.

The seed creates, through the application's own API, as the persona who would do each step:

| Module | Record | State |
|---|---|---|
| Sourcing | Second source for piston ring kits (PILOT) | INT-01 open for completion |
| Inspections | Lot PILOT-101 | Completed; **OPS-02 approved**, controlled PDF |
| Inspections | Lot PILOT-102 (Sam Okafor) | In progress; OPS-02 open |
| Inspections → NCR | Lot PILOT-103 failed and held; NCR contained | OPS-06 open; disposition next |
| SCAR | Missing running-face coating | Supplier response recorded; OPS-07 open |
| Concessions | Lot PILOT-104 | OPS-05 submitted; Engineering concurrence and decision next |
| Concessions | Lot PILOT-105 | Approved; **OPS-05 completed**, controlled PDF |
| First articles | FA-PILOT-01 on the Northwind P1 source | Measured; VAL-02 open |
| Changes | Tighten radial wall tolerance | Impact assessed; OPS-04 open |

**Supplier agreements (pilot).** A separate stage loads them at the same start, once (`system_setting.pilot_agreements`). It does not wait for the controlled templates. It creates, through the API as the personas:

- **Document Library:** synthetic `MSA-001` Rev S01 and `SCS-001` Rev S1.0, classified (master agreement; casting specification), with the SCS-001 clauses. Both are marked *SYNTHETIC TEST DOCUMENT* on every page; the `S` labels let the approved files import later as ordinary revisions.
- **Bluestone Castings (FA):**
  - an agreement executed from a fictional signed copy;
  - its renewal, executed, which supersedes it;
  - SCS-001 Rev S1.1 released, with its revision review;
  - an executed amendment incorporating S1.1.
- **Northwind (P1):** a draft agreement.

The legal review and signatures are fictional and have no legal effect.

To start again: delete and recreate the test database and disk (or create a new Blueprint instance), then repeat steps 1–3.

## Personas

All personas use `TQMS_DEMO_PASSWORD`. Independent approval (POL-01) needs a different person for each role on a record, so one tester signs out and in as the persona named in each step.

| Persona | Sign-in | Typical role |
|---|---|---|
| Jordan Rivera | jordan.rivera@example.com | Receiving inspector; requests concessions |
| Sam Okafor | sam.okafor@example.com | Second inspector |
| Casey Morgan | casey.morgan@example.com | Quality: inspection review, first-article decision, SCAR implementation verification, NCR follow-up |
| Taylor Brooks | taylor.brooks@example.com | Engineering: concurrence blocks, NCR closure, changes |
| Morgan Diaz | morgan.diaz@example.com | Purchasing/sourcing: sourcing requests, FAIs, SCARs, changes |
| Riley Chen | riley.chen@example.com | Management: concession, source and change decisions, dispositions, SCAR closure |
| Avery Patel | avery.patel@example.com | Administrator: Document Library |

## Smoke-test checklist

Tick each line; each "→" is the persona to sign in as.

1. [ ] `https://<tqm-test URL>/health/ready` returns `ready`. The sidebar shows **TEST**.
2. [ ] → Avery: **Documents** lists the imported types at Rev 03 in force; OPS-06 shows its derived structure (sections, schedules, document control).
3. [ ] → Casey: **Inspections → PILOT-101**: the OPS-02 panel says *Approved through confirm review*. **Controlled PDF** opens, and the validation list shows Pass for all seven checks. The inspection's own PDF reads *INSPECTION WORKSHEET - NOT THE CONTROLLED RECORD*.
4. [ ] → Sam: open **PILOT-102**, finish the inspection, open its OPS-02 from the panel. Readings are locked; add equipment IDs and the sampling entries. Complete the inspection (this submits OPS-02). → Casey: **Confirm review**; OPS-02 completes with its PDF.
5. [ ] → Riley: on the PILOT-103 NCR, record a disposition. → Casey: verify it. → Casey: complete OPS-06 and **Submit for decision**. → Taylor: **Close NCR…**; OPS-06 completes. No *Issue summary PDF* button remains.
6. [ ] → Taylor: open OPS-05 for PILOT-104 and **Sign…** the Engineering approver. → Riley: on the concession, the panel says *Ready for Decide concession*; **Approve…**; OPS-05 completes.
7. [ ] → Casey: verify the SCAR implementation (attach evidence first). → Morgan: record the effectiveness plan. → Riley: verify effectiveness. → Morgan: complete OPS-07 and submit. → Riley: **Close SCAR…**; OPS-07 completes.
8. [ ] → Morgan: complete VAL-02 (Source page, first article) and submit. → Taylor: sign Engineering. → Casey: **Decide…** the first article; VAL-02 completes.
9. [ ] → Morgan: complete OPS-04 and submit. → Taylor: sign Engineering. → Riley: **Decide…** the change; OPS-04 completes.
10. [ ] → Morgan: complete INT-01 and submit. → Taylor: sign the PDI decision (*Investigate*). → Casey: sign; INT-01 completes.
11. [ ] One path only: on any submitted event record, the module's approval block shows *Signed when you … on the …* with no **Sign…** button; deciding in the module before the form is submitted is refused with the reason.
12. [ ] → Morgan: **Suppliers → Northwind → Controlled forms → SUP-01** starts, completes and is approved by Casey (a form that is not tied to a module event).

13. [ ] → Casey: **Suppliers → Bluestone Castings → Agreements & Specifications** shows the renewal as the current agreement, SCS-001 Rev S1.1 and the TQ-CYH-4004 schedule, the executed amendment, and the superseded original with its signed copy and package PDFs. The full owner walkthrough is in [release-notes/2026-11-supplier-agreements.md](../release-notes/2026-11-supplier-agreements.md#manual-acceptance-pdi-owner).

If a step fails, note the persona, the page and the message shown.
