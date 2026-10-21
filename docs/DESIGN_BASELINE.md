# TQMS design baseline (Stages 0–5)

Source: *PDI TQMS Zero-to-Production Construction Set* (20 Oct 2026). The authoritative requirements are copied verbatim in [`requirements/`](requirements) and the construction drawings in [`construction/`](construction). This file covers items (a)–(e) of the master prompt's Part XI response contract.

Status vocabulary (Drawing F1): **implemented** → **unit-tested** → **integration-tested** → **UI-tested** → **staging-tested** → **PDI-approved** → **production-released**. Nothing here is beyond UI-tested. Nothing has been deployed to Render, and no real data has been used.

## (a) Implementation plan mapped to P0 and acceptance tests

| Stage | Scope | AT cases | State |
|---|---|---|---|
| 0 Foundation | identity, grants, sessions, CSRF, audit, numbering, evidence disk, jobs, migrations, health/readiness, Docker | AT-19 (part), AT-21 (part), NEG-10/11/12/13 | **Built in this PR** (backup tooling followed in Stage 5) |
| 1 Inspector's room | Appendix A catalogue, launch, multi-unit workbench, all specialized patterns, photos, partial/complete, independent review, amendments, branded PDF, linked concern + triage | AT-01, AT-02 (part), AT-03 (part), AT-04, AT-06 (part) | **Built in this PR** |
| 2 Supplier/engineering | site qualification, A/B/C sourcing, baseline release workflow and UI, FAI reject/resubmit, supplier acknowledgment, source approval with frozen manifest | AT-09–AT-13, AT-17, NEG-04, NEG-05 | **Built (Stage 2 PR)** |
| 3 Quality/change | NCR scope/containment/disposition/verification/release, concession, SCAR/8D/effectiveness/recurrence, supplier commitments with reminders, change control, form-revision editor and one-off forms, OPS-03/04/05/06/07/08 PDFs | AT-02, AT-03, AT-06, AT-07, AT-08, AT-12 (concession gate), AT-14–AT-16, AT-18, NEG-01, NEG-06–08, NEG-17, NEG-18 | **Built (Stage 3 PR)** |
| 4 Injector & management | serialized injectors, idempotent bench-file import (interim adapter), manual tests, repair cases with quick measurements, retest attribution, comparison, shipment evaluation, injector analytics; management overview with shared metric definitions, drill-down, CSV exports, issued management report PDF; traceability by part + lot or serial | AT-05, AT-20, NEG-09, NEG-22 | **Built (Stage 4 PR)** |
| 5 Finishes | authorization sweep over every route, adversarial cases (concurrency, tampering, corrupt evidence, mismatched identity), application-consistent backup + isolated restore verification, accessibility audit (axe, keyboard-only, empty/validation states), link crawler, screen + PDF visual baselines, performance at 3 and 15 years of volume, admin password reset | AT-19, AT-21, NEG-14, NEG-21 | **Built (Stage 5 PR)** |
| 6 Inspection & occupancy | Render staging, backup/restore drill on Render with an approved off-site destination, PDI sign-off, production go/no-go | AT-21/NEG-14 on staging | Not started; needs owner approval |

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
| POL-01 | Authority grants and independence exceptions | Capabilities granted per person. Inspection reviewer ≠ inspector; baseline and form releaser ≠ author/submitter; qualification decider ≠ assessor; FAI decider ≠ recorder/measurer; source approver ≠ sourcing request owner; NCR confirmer ≠ concern reporter; concession approver ≠ requester; material releaser ≠ disposition decider; SCAR effectiveness verifier ≠ implementation verifier; change approver ≠ requester; no exception path |
| POL-02 | Acceptance limits, units, methods, CTQ, effectivity | Without a released baseline limit, readings are observations and need Engineering review; no PASS is calculated |
| POL-03 | Sampling/AQL, lot handling, release with missing baseline | Sample size is entered by hand; completing an inspection never releases material |
| POL-04 | Risk method, assessment/FAI/PPAP triggers, SCAR/suspension criteria, response due dates | `RISK-INTERIM-1` and `CHECKLIST-INTERIM-1` as in Stage 2. SCAR effectiveness needs a completed, non-failing inspection received after implementation was verified, or a documented alternative with evidence. `REMINDER-INTERIM-1`: overdue commitments get a daily in-app reminder; HIGH escalates to management at once, MEDIUM after 7 days, LOW is only reminded. E-mail stays disabled |
| POL-05 | Concessions, containment, partial release, physical verification | `DISPOSITION-INTERIM-1`: containment authorized by management and physically verified on site; disposition per quantity/serial; use-as-is only under a current approved concession for the same part and lot within its quantity; rework/repair verified only by a PDI reinspection of the same lot showing the failed characteristic conforms; release by someone other than the decider; no ERP stock movement |
| POL-06 | Change effectivity, old lots, requalification | Impact assessment before decision; a site change always requires requalification; effectivity needs the new baseline revision released (optional first lot); implementation is verified by a completed, passing inspection of an affected source on or after the effective date under the changed revision; earlier lots keep their recorded revision |
| POL-07 | Signature format, brand artwork/fonts/colors, numbering, retention | Reference logo extract + suggested navy tokens; `IR-`/`QE-`/`NCR-`/`DEV-`/`SCAR-`/`COM-`/`CHG-`/`BI-`/`REP-`/`SHP-`/`CMP-`/`MR-YYYY-NNNNN`; the management report uses the uncatalogued code `TQMS-MR`; controlled record PDFs issued as numbered editions; nothing destructively deleted |
| POL-08 | Injector bench formats and rules | Interim synthetic layout `TQMS-BENCH-CSV-1` (one row per measured value; labelled *not a CarbonZapp format*). No bench integration. A PDI verdict is calculated only from released FUNCTIONAL baseline characteristics referenced `injector:<condition>__<parameter>`, compared exactly and only in the same unit; otherwise the result is NO_CRITERIA / PARTIAL_CRITERIA and the machine verdict is shown separately, never as a PDI verdict. Must be validated against real bench files before production |
| POL-09 | Render budget/sizing, monitoring owner, RPO/RTO, off-site backup, MFA, launch gate | Local + template only; nothing provisioned. Backup tooling exists (`backup:create` / `backup:verify`); its schedule, encrypted off-site destination, RPO/RTO and owner are open. The database must allow the trusted `pg_trgm` extension (migration 0008) |
| POL-10 | Whether historical sample reports/photos may be imported | Nothing imported; all fixtures fabricated |
| POL-11 | Authority/timing for Accepted results (FR-050) | Requires reviewer holding `inspection.review_accepted` |
| POL-12 | Validation of Appendix A form texts/revisions | Loaded as released, marked "PDI owner validation pending" |
| POL-13 | Suspension propagation (FR-022) | Conservative: an active supplier or site restriction shows every affected approved source as SUSPENDED (decision records unchanged), blocks new approvals and flags new inspections; reinstatement is a separate, reasoned decision |
| POL-14 | NCR closure with open SCAR; which NCR states block approval (FR-075) | `NCR-BLOCK-INTERIM-1`: an NCR closes after verified material resolution while a linked SCAR stays open and visible; open HIGH/CRITICAL NCRs and untriaged concerns block source approval; other open NCRs and current concessions allow only conditional approval; an expired concession on an open NCR blocks |
| POL-15 | Retention schedule (FR-095) | Retain everything |
| POL-16 | Display time zone | `DISPLAY_TIMEZONE` setting |

## Design decisions and resolved contradictions

1. **Storage.** The older S3 proposal is superseded by the construction set's Render disk (authority order rule 1). Files are written to staging → fsync → atomic link into an immutable object tree; metadata is committed after the durable write; objects are addressed by random UUID keys. A volume marker plus a database pairing check means an unmounted or mismatched disk fails readiness instead of silently using ephemeral storage.
2. **Legacy "Computed: None" (Appendix A A2).** Treated as a defect, as Part VIII instructs. With a released limit, readings are compared exactly (BigInt decimals, never float-rounded); a value outside the limit cannot be recorded as Pass. Without a released limit, entry is allowed, the row shows "Specification not released — Engineering review required", and completion goes to review instead of a calculated PASS (NEG-16).
3. **Form text vs released limits.** Specifications printed on forms (e.g. groove depth .029–.031") are displayed as *reference text*, never as limits. Only released technical-baseline characteristics (linked by `form_row_ref`) govern.
4. **N/A outside the receiving checklist.** Appendix A lists P/F/A for item rows, but several rows are conditional ("two-piece only", "combination bearings only"). N/A is allowed on every row and needs a reason outside the receiving checklist, so it is never a silent skip (NEG-24).
5. **Unit and overall outcomes** are derived, never typed: worst of FAIL > ACCEPTED > PASS across the shared receiving section and every item. Inspection outcome, review status and material authorization are separate fields and are labelled separately on screen and in the PDF.
6. **Review routing.** Completion goes straight to COMPLETED only when everything passes against released limits. FAIL, ACCEPTED, or unreleased-limit readings go to READY_FOR_REVIEW, locked, until a different person with `inspection.review` confirms it or returns it with a reason. Accepted results also need `inspection.review_accepted`.
7. **Immutability is enforced by database triggers**, not only by the service layer. Covered: released form and baseline revisions, completed inspections and their entries, available files, report snapshots and renditions, reviews, amendments, decided qualifications and FAIs, risk assessments, supplier responses, lifted restrictions, source approval decisions, the identity of any once-approved source, and the append-only audit table. Corrections are amendment layers (`amendment_no > 0`) that produce a new report edition; earlier editions stay downloadable with their original hash.
8. **Reports** are rendered by a background job from a frozen JSON snapshot (canonical-JSON SHA-256). Photo bytes are hash-verified when rendered. A job abandoned by a crashed worker is reclaimed, and rendering is idempotent per snapshot.
9. **Exact-source approval (FR-032, FR-036, FR-037).** Approval is for one part + supplier + manufacturing site + supplier part/configuration + governing baseline revision. Gates are re-evaluated inside the decision transaction: released baseline with ownership matching the pathway (A→PDI, B→supplier, C→supplier base + released PDI delta), supplier not restricted, *that* site qualified and current, supplier acknowledgment of the exact revision, accepted FAI, risk assessed, required evidence satisfied (with files) or waived with authority, and no open quality concern on the source. A failing gate refuses the decision and is audited; a warning allows only a conditional approval. The decision stores a canonical-JSON manifest with SHA-256 and is immutable; a background job renders the *Product & Supplier Approval Record* PDF from it.
10. **Effective source status** (SUSPENDED / EXPIRED / AT RISK) is computed over the immutable decision from restrictions and qualification validity, so suspension never edits history and reinstatement restores the source without a new approval. A sibling site never inherits approval (NEG-04): an inspection against it records the effective state at start.
11. **Sourcing pathways.** The pathway is locked once risk is assessed. A preliminary (draft or reverse-engineered) baseline revision cannot govern a source. Path C copies the supplier base characteristics and marks PDI-specific rows as delta; a later supplier base revision is reported but does not replace the governing configuration.
12. **FAI history (FR-033, FR-034).** Decided samples are immutable. After a rejection the next sample must be registered as a resubmission with a corrective rationale, and the rejection stays visible next to the acceptance.
13. **Document evidence** accepts PDFs (header/trailer checked; active content such as JavaScript, launch actions, embedded files, XFA and form submission is refused) and images, up to `MAX_DOCUMENT_MB`.
14. **Nonconformance (C5, FR-070–075).** A triaged concern is confirmed as an NCR by someone other than the reporter; the NCR links the same stored photos. Affected material is recorded per lot/quantity/serial; containment is authorized by management and physically verified on site. Dispositions are decided per quantity (never a blanket lot decision from one sample), are immutable (voiding keeps them on record), and are verified separately: rework/repair only by a completed PDI reinspection of the *same* lot after the decision showing the failed characteristic conforming against a released limit (NEG-08); a return or scrap by its record. Release is a separate action by someone other than the decider. NCR and scope states are derived from these records, never typed.
15. **Concessions (FR-073, AT-14).** A concession names part, optional exact source, lot, quantity, characteristic, exception and dates; it is approved by someone other than the requester, cannot overlap another approved concession for the same lot and characteristic, and is consumed by recorded uses (database-enforced quantity). Use and release re-check its dates on the day, so a later date or another shipment never inherits it. Confirming an Accepted inspection result can consume a concession for the accepted items (AT-02).
16. **SCAR (FR-074, AT-15).** Supplier responses are kept as numbered revisions in an 8D-style structure and never advance the SCAR by themselves (NEG-07). Implementation needs objective PDI evidence; effectiveness needs a plan, a verifier other than the implementation verifier, and later production evidence. A recurrence NCR reopens a verified or closed SCAR into a new cycle; earlier responses and verifications stay frozen.
17. **Supplier commitments and change control (C6, C7).** A commitment records the representative, channel, statement, promised action, owner, due date (or a reason for none) and verification method; a supplier claim is only a claim, a failed verification keeps the duty open with its owner, and the exact source can be restricted (`RESTRICTED` status overlay). Changes go through impact assessment, an independent decision, effectivity after the revision is released, and verification on the first conforming lot; approved changes requiring requalification mark affected approved sources `REQUALIFICATION_REQUIRED` until verified (NEG-17).
18. **Forms (FR-042, AT-03).** Revisions are drafted from the released revision, edited in a structured editor (rows of existing keys keep their keys; new rows are keyed from their names), submitted, and released by someone other than the author; release supersedes the prior revision. One-off inspections store an immutable `ONE_OFF` revision of the Miscellaneous form, copy a released receiving checklist, and always require independent review.
19. **Bench imports (FR-060, NEG-09, NEG-22).** The original file is stored unchanged and linked to the import record. A test is identified by machine + normalized serial + test time (time zone required) + sequence; the same key with the same content is skipped, with different content is a *conflict* that never overwrites the original. Invalid tests are excluded whole with a line-referenced reason; unknown part numbers are excluded. The whole import is one transaction (the import record is written last through a deferred foreign key), so an interruption leaves no tests, injectors, file record or stored object. Test values and verdicts are immutable (trigger); only a retest attribution may be added once.
20. **Repair and retest (FR-062, C9).** A repair case holds immutable actions with optional quick measurements (recorded as entered; no limits implied). A retest is attributed to an action only if it was performed after it, and a case closes only once a retest is attributed. The chronology labels first test, retest after repair, shipment evaluation and other retests.
21. **Comparison and shipment evaluation (FR-061, FR-063).** Comparisons keep the selected order and put values recorded in different units on separate rows. A shipment evaluation freezes each injector's latest test with its PDI evaluation and machine verdict; anything not fully covered by released PDI criteria, or untested, is an exception. It is explicitly not a material release.
22. **Metric definitions (FR-102, C10).** `METRICS-INTERIM-1` definitions live in `src/shared/reports.ts` and are shown on screen, written into every CSV header and frozen into each issued report. Home and the overview call the same `currentCounts`; inspection outcomes always use the latest amended outcome, and the inspection list's drill-down filters use the same SQL. Period figures use whole dates in the display time zone; "now" figures ignore the period. Expiry uses a selectable reporting window (default 90 days), stated as not a policy limit.
23. **Exports.** CSV exports require `reports.export`, are audited (denials too), and neutralize spreadsheet formula triggers while keeping plain numbers numeric.
24. **Traceability (AT-20, FR-010).** For part + lot or a serial, the trace lists inspections with the exact form revision and spec snapshot, FAI history with nonconforming characteristics, quality events, NCR material scopes and dispositions, concessions, changes and bench history. "What applied on this date" is computed from the decision history at the end of that date: latest released requirement revision per baseline, latest source approval and its validity, restrictions and site qualification then in force, concessions and changes in effect — separately from the source's current status.
25. **Notifications.** In-app only: the work queue and the hourly reminder sweep (Stage 3). E-mail delivery remains disabled pending owner approval.
26. **Authorization sweep (F1).** The application records its own route inventory at startup (`onRoute`), and a test sends every route an unauthenticated request (401), a request without the CSRF token (403) and a read-only user's request (403 on every write, export and administration route). Handlers check authority before validating the request body, so denials are audited even for malformed requests. Writes whose authority depends on the record (owner, requester, evidence type) check that record first.
27. **Concurrency.** "Only one open X" rules (open repair case, assessment under review, draft revision, pending acknowledgment, open FAI, open concern per row, sourcing request per source) are partial unique indexes (migration 0007), so simultaneous requests cannot both pass a check-then-insert; the loser gets a plain 409 message.
28. **Corrupt evidence.** A stored object whose bytes no longer match its SHA-256 stops report rendering as a permanent, administrator-visible job failure that names the remedy (restore from backup); it is never retried as if transient.
29. **Backup format `TQMS-BACKUP-1` (D2, AT-21, NEG-14).** One exported snapshot drives both `pg_dump --snapshot` and the evidence file list, so database and files are coordinated; every object is hash-checked while copied; a manifest (with its own SHA-256) records counts, schema version and volume. `backup:verify` restores into a new isolated database and storage root and checks counts, schema, every evidence link and report edition, volume pairing and application readiness. A database-only, altered or mixed set is reported INCOMPLETE (exit 2), never success, and so is a restore target older than the tools that wrote the dump (PostgreSQL does not guarantee that). Verified in the production image against PostgreSQL 17. Off-site encrypted copy is an operator step pending POL-09.
30. **Accessibility.** Every destination is scanned with axe-core (WCAG 2.0/2.1 A and AA) at desktop and phone width; serious/critical findings fail the build. Theme tokens were adjusted to meet 4.5:1 text contrast on every surface. Dialogs move focus to their first field; the launch dialog states what is still needed and marks invalid item counts.
31. **Visual regression.** Screen baselines and page-by-page PDF baselines (piston, 12-unit liner, accepted head, accepted crankshaft, failed bearing, image-heavy turbo, NCR, SCAR) render with a pinned font set (`tests/fixtures/fonts.conf`) so results do not depend on the machine; PDFs render from frozen snapshots captured from real API runs (`scripts/capture-pdf-fixtures.ts`). Deliberate colour and 3 pt layout changes were confirmed to fail.
32. **Performance.** Serial lookups use an expression index on the same normalization as the queries; substring searches use pg_trgm indexes with one query per column; optional filters are built only when supplied. Budgets are engineering targets for the test machine, not policy.
33. **Name and logo (owner decision, 21 Oct 2026).** The application is presented as **TQM** (Total Quality Management) in the interface, browser title, PDFs and exports. Internal identifiers keep the TQMS prefix (environment variables such as `TQMS_BOOTSTRAP_PASSWORD`, the `TQMS-BACKUP-1` and `TQMS-BENCH-CSV-1` formats, the `TQMS-MR` document code, database and service names) so existing settings, backups and issued document numbers stay valid. The owner supplied the PDI logo artwork (transparent PNG, cropped and stored as `assets/brand/pdi-logo.png`); it replaces the reference-only copy in the sidebar, sign-in page and PDF mastheads, drawn directly on navy.

## (d) Acceptance matrix (current state)

Test files: `U` = `tests/unit/domain.test.ts`, `I` = `tests/integration/inspection.test.ts`, `R` = `tests/integration/reports.test.ts`, `S` = `tests/integration/sourcing.test.ts`, `Q` = `tests/integration/quality.test.ts`, `E` = `tests/e2e/inspection.spec.ts`, `E2` = `tests/e2e/sourcing.spec.ts`, `E3` = `tests/e2e/quality.spec.ts`, `J` = `tests/integration/injectors.test.ts`, `M` = `tests/integration/management.test.ts`, `UJ` = `tests/unit/injectors.test.ts`, `E4` = `tests/e2e/injectors.spec.ts`, `E5` = `tests/e2e/reports.spec.ts`, `A` = `tests/integration/authorization.test.ts`, `X` = `tests/integration/adversarial.test.ts`, `B` = `tests/integration/backup.test.ts`, `P` = `tests/integration/performance.test.ts`, `E6` = `tests/e2e/accessibility.spec.ts`, `E7` = `tests/e2e/pdf-visual.spec.ts` + `visual.spec.ts`, `E8` = `tests/e2e/walk-links.spec.ts`.

| Case | State | Evidence |
|---|---|---|
| AT-01 receiving multi-item | UI-tested | I "AT-01…", E "AT-01 inspector walkthrough", U completion rules |
| AT-02 accepted item | Integration-tested: Accepted confirmed only with review-accepted authority; a current concession for the lot is consumed; outcome stays ACCEPTED | Q "AT-02…", I, R crankshaft |
| AT-03 template history | UI-tested: draft → edit → submit → independent release; old inspections keep their revision | Q "AT-03 / NEG-03…", E3 "Form editor…", I |
| AT-04 special measurements | Integration + PDF tested | R six-cylinder head, I/U ring end-gap limits, U vacuum/valve rules |
| AT-05 injector | UI-tested with synthetic bench data: import with per-test report, auto-registration, separate machine/PDI verdicts, repair with quick measurements, attributed retest, comparison (CSV + PDF), shipment evaluation PDF, analytics with explicit denominators. Real bench formats are POL-08 open | J, UJ, E4 |
| AT-06 concern → NCR | UI-tested: concern → triage → NCR with the same photos → scope → containment → disposition → verification → close; SCAR issued | Q "AT-06…", E3 walkthrough |
| AT-07 supplier coating | Integration-tested: commitment tied to the exact source and revision; supplier claim ≠ verification; failed incoming inspection fails it; source restricted; duty stays open with its owner | Q "AT-07…" |
| AT-08 FAI recurrence | Integration-tested: later NCR linked as recurrence reopens the SCAR; NCR shows rejected and accepted FAIs with results, approvals, prior NCRs and follow-up | Q "AT-08…", S FAI test |
| AT-09 sourcing A | Integration-tested | S Path A chain (intake → preliminary draft cannot govern → independent release → site qualification → FAI → acknowledgment → approval) |
| AT-10 sourcing B | UI-tested | S "needs only proportionate evidence…", E2 walkthrough |
| AT-11 sourcing C | Integration-tested | S "keeps the PDI delta on the exact supplier base…" |
| AT-12 approval gates | Integration-tested, including blocking NCR, current concession (conditional only), expired concession on an open NCR, and pending change requalification | S, Q "NEG-06 / AT-14…", Q "AT-16…" |
| AT-13 supplier suspension | Integration-tested | S "AT-13: suspending the site…" |
| AT-14 material concession | Integration-tested: lot-, quantity- and date-bounded; other lot and expired concession refused; exhausted after use | Q "NEG-06 / AT-14 / AT-19…", U |
| AT-15 supplier corrective action | UI-tested: 8D response, PDI implementation evidence, independent effectiveness on later production, SCAR open after NCR closure | Q "AT-15…", E3 |
| AT-16 change control | Integration-tested: before/after diff, impact, independent decision, requalification actions with objective evidence, effectivity, first-lot verification, per-lot revision history | Q "AT-16 / NEG-17…", E3 (proposal + impact) |
| AT-18 ownership | Integration-tested: overdue reminders and severity escalation (idempotent), My Work overdue flag, verification with evidence, supplier history | Q "AT-18…", E3 (record from supplier hub), U |
| AT-17 documents/PPAP | Integration-tested: HIGH-risk checklist with PPAP elements satisfied or waived; LOW-risk list stays short; approval record PDF lists exact revisions and files | S, `var/report-samples/source-approval-record.pdf` |
| AT-19 roles | Integration-tested: an inspector cannot release a drawing, amend finalized results, decide their own concession or approve a source; a cross-functional manager inspects and decides others' requests but not their own | I, S independence; Q: inspector cannot disposition (NEG-01), nobody approves their own concession/change/form, release ≠ decider, effectiveness ≠ implementation verifier; J/M: only `injector.test` imports, only `injector.evaluate` freezes shipment evaluations, only `reports.export` exports or issues reports (denials audited); A: AT-19 role walkthrough and the full-route sweep |
| AT-20 traceability | UI-tested: part + lot or serial returns inspections (form/spec revision, photos, flagged rows), FAI defects, NCR/disposition/concession/change history, bench history, and what applied on a chosen date; search also finds injectors, bench imports and documents by file name | M "AT-20…", J search, E4 trace |
| AT-21 failure recovery | Integration-tested locally: unsaved-entry restore, upload failure message, report-job reclaim, redeploy persistence, corrupt evidence stops rendering visibly, application-consistent backup restored into an isolated environment with every evidence link and report edition validated. Not yet run on Render (Stage 6) | E "AT-21", I "report job recovery", X, B, Docker redeploy check |
| NEG-01 | Integration-tested: inspector calling the disposition API is denied and audited; no decision recorded | Q |
| NEG-02, NEG-03 | Integration-tested | I |
| NEG-10, NEG-11, NEG-12 | Integration-tested (NEG-12 also in Docker) | I, U |
| NEG-13 | Manually verified in Docker (container replaced; PDF/photo hashes and draft unchanged) | milestone report |
| NEG-15 | UI-tested (390 px, 100 items; axe at phone width) | E phone test, E6 |
| NEG-16, NEG-23, NEG-24 | Integration + unit tested | I, U |
| NEG-18 | Integration-tested: no generic close/status endpoint; SCAR/NCR guarded by triggers | I, Q |
| NEG-19 | Integration-tested | I |
| NEG-20 | By construction: no reference reports or photos in repo/fixtures | `tests/fixtures/images.ts` |
| NEG-21 | UI-tested: link crawler follows every visible in-app link for a manager and an inspector (no Page not found, missing heading, browser error or failed API call) | E8, E navigation test |
| NEG-04 | Integration-tested: sibling site not approved; inspection records the effective state | S Path B |
| NEG-05 | Integration-tested: explicit gate failures with links, no partial approval | S Path A, Path C |
| NEG-06, NEG-07, NEG-08 | Integration-tested | Q |
| NEG-17 | Integration-tested: approved source shows REQUALIFICATION_REQUIRED and the CHANGE_CONTROL gate fails until implementation is verified | Q "AT-16 / NEG-17…" |
| NEG-09 | Integration-tested: same file → DUPLICATE_FILE, nothing added; changed value under the same key → conflict, original unchanged | J |
| NEG-22 | Integration-tested: an import interrupted after the second test leaves every table and the storage object unchanged; re-running imports each test once | J |
| NEG-14 | Integration-tested locally: a database-only, altered or mixed backup set is reported INCOMPLETE and nothing is restored; Render drill pending (Stage 6) | B |

### Functional requirement status (all 89 requirements)

State is **Built**, **Partial** (the missing part is named) or **Not built**. Test letters refer to the legend in (d).

| FR | State | What exists | Tests |
|---|---|---|---|
| FR-001 | Built | Per-person capability grants (`src/shared/capabilities.ts`, `auth.ts`); every action audited with actor and time | U, I, A |
| FR-002 | Partial | Supplier, sites, category, status, notes, certificates, qualification history (`sourcing/suppliers.ts`). **No supplier contacts or agreements register** | S |
| FR-003 | Built | Part, aliases/OE cross-references, supplier part, site, configuration, governing revision (`source` identity, migration 0002) | S, I |
| FR-004 | Built | Revision-specific baselines with characteristics/limits, special characteristics, methods (`sourcing/baselines.ts`) | S, I |
| FR-005 | Built | Sourcing intake, rationale, owner/dates, pathway, risk, evidence, FAI, decision history, approval package | S, E2 |
| FR-006 | Built | Inspection header: PO, supplier/site, part, received date, lot, quantities, serials, revision and approval state at start | I, E |
| FR-007 | Built | Concern → NCR → containment/disposition → concession → SCAR → change, linked (`quality/*`, `changes/changes.ts`) | Q, E3 |
| FR-008 | Partial | Controlled record numbers, editions, hashes, evidence links. **No generic document register (owner/lifecycle/retention class per document)** | Q, R |
| FR-009 | Partial | Per-record history from the audit trail; commitment events record supplier positions. **No free-form comment threads** | Q |
| FR-010 | Built | Hubs + `/api/trace` (part + lot or serial; what applied on a date) | M, E4 |
| FR-011 | Built | Unified work queue; team view for `work.view_team`; overdue flags (`/api/home`) | I, Q |
| FR-012 | Built | Quick Capture from any page (`QuickCapture.tsx`) | I |
| FR-013 | Built | Owner, due date or reason, reminders/escalation by severity (`quality/commitments.ts`, REMINDER-INTERIM-1) | Q AT-18 |
| FR-014 | Built | Representative, channel, promise, due date, product/revision link, verification | Q AT-07 |
| FR-015 | Built | Confirming an NCR prompts scope, containment and disposition; the quick-capture record stays linked | Q AT-06 |
| FR-016 | Built | Quality context cards on part, source and supplier hubs (`quality/context.ts`) | Q |
| FR-020 | Partial | Prospective suppliers/sites, capabilities, certificates with expiry, restrictions, reasoned transitions. **No contacts** | S |
| FR-021 | Built | Qualification per supplier or named site, decided by someone other than the assessor | S |
| FR-022 | Built (interim) | Suspension/expiry overlays on sources, blocks new approvals (POL-13 open) | S AT-13 |
| FR-023 [P1] | Partial | Certificate/qualification expiry listed in Reports (`reports/metrics.ts`); supplier fail rates from inspections. **No renewal reminders, no delivery performance** | M |
| FR-024 – FR-027 | Built | Pathways A/B/C, risk method RISK-INTERIM-1, proportionate checklist with waivers | S |
| FR-028, FR-029 | Built | Baseline editor, draft vs released, effective dates | S |
| FR-030 | Built | Supplier acknowledgment of the exact revision | S |
| FR-031 | Partial | Newer supplier base flagged; reassessment through change control. **No automatic WIP/stock reassessment** | S, Q |
| FR-032 – FR-034 | Built | Exact-source approval; FAI history with rejected sample kept | S |
| FR-035 | Partial | FAI measured values with independent decision. **No validation plan / test-procedure records per source** | S |
| FR-036, FR-037 | Built | Gates re-evaluated at decision; frozen hashed manifest and PDF | S |
| FR-038 [P1] | Partial | Approval record lists the evidence package. **No combined PPAP package export** | S |
| FR-040, FR-041 | Built | Inspections list (search, status, outcome, mine, report drill-down); compact launch dialog with validation messages | I, E, E6 |
| FR-042 | Built | Form editor, release by another person, one-off inspections | Q, E3 |
| FR-043 – FR-051 | Built | Workbench: sticky header, shared section once, item tabs, P/F/A/N, row photos, measurements, specialised patterns, outcomes, partial save | I, U, E, E6 |
| FR-052, FR-053 | Built | Summary, print preview, branded PDF editions; inspections CSV export | R, E7 |
| FR-054 | Built | Concern from a failed row carries identity and the same photos | I, Q |
| FR-055 | Built | Frozen form/spec snapshots; triggers prevent changes | I, X |
| FR-056 | Built | List counts and filters share definitions; reports drill into the same filters | I, M |
| FR-057, FR-058 | Built | Walkthroughs automated | E, E3 |
| FR-060 | Built (interim) | Idempotent bench import, manual tests (`injectors/bench.ts`); real formats POL-08 open | J, UJ, X |
| FR-061 – FR-063 | Built | Search/filter, chronology, repair cases, quick measurements, comparison, shipment evaluation, analytics | J, E4 |
| FR-064 | Partial | Exports restricted to `reports.export`. **No configurable external destinations or scheduled reporting** (POL-08) | J, A |
| FR-070 – FR-074 | Built | NCR, scope, containment, disposition, verification, release, concession, SCAR/8D | Q, E3 |
| FR-075 | Built (interim) | NCR-BLOCK-INTERIM-1 (POL-14 open) | Q |
| FR-076 | Built | Concessions and open quality shown on inspections, sources and hubs | Q |
| FR-080 – FR-084 | Built | Change control with impact, decision, effectivity, implementation verification, requalification overlay | Q AT-16 |
| FR-090 | Not built | No administrative catalogue of document types; Appendix B records exist as specific screens/PDFs | — |
| FR-091 | Partial | Draft → review → released → superseded for baselines and forms; controlled PDFs as editions. **Not for arbitrary documents** | S, Q |
| FR-092 | Built | Structured records with PDI-branded PDFs; supplier files attached as evidence | Q, R |
| FR-093 | Built | Checklist of required/conditional/waived evidence per source | S |
| FR-094 | Built | Acknowledgment of exact revision, recipient, date, response | S |
| FR-095 | Partial (policy open) | Nothing is deleted; decision chains are immutable. **Retention schedule not configurable** (POL-15) | X |
| FR-100 | Built | My Work landing page | I |
| FR-101 | Partial | Search across parts, suppliers, inspections, concerns, NCR/SCAR/concessions/changes/commitments, injectors, bench data, documents by file name. **No comments to search** | M, J, E4 |
| FR-102, FR-103 | Built | Management overview, CSV exports, issued report PDF | M, E5 |
| FR-104 [P1] | Built | Recurrence groups and repeated rejected-FAI defects | M |
| FR-110 | Partial | Local accounts, lockout, session revocation, deactivation, administrator-set temporary password. **No e-mail invitations or self-service reset** (e-mail disabled until approved); SSO optional | I, A |
| FR-111 | Built | Every route checked: unauthenticated, missing CSRF and read-only sweeps over the live route inventory | A |
| FR-112 | Built | Append-only audit with reason, before/after where relevant; denials audited | I, A |
| FR-113 | Built | Validated uploads, previews, captions, size limits, durable links, verified backup/restore | I, B |
| FR-114 | Built | Job queue with permanent/retryable failures visible to administrators; search and lists measured at 3 and 15 years of volume | X, P |
| FR-115 | Partial | Backup + isolated restore verification, logs, readiness, CI. **Staging/production separation and monitoring owner await Render provisioning** (POL-09) | B |
| FR-116 | Partial | Policy register visible; interim rules are versioned in code. **Policy decisions are not configurable in the UI** | — |

## (e) First vertical transaction (delivered)

An inspector searches a part (including by OE alias) and launches the suggested released form against an exact source. They answer the shared receiving section once, complete serialized items with checklist answers, measurements (compared against the released synthetic baseline) and row photos, then save, reload and resume. Completion is blocked with exact-path messages until required evidence is present. A failed result goes to an independent reviewer; confirmation freezes the record and a background job renders the branded PDF edition with a stored SHA-256. An authorized amendment adds a new edition and leaves the original untouched. A concern raised from a failed row carries the identity, expected/actual values and the *same* photo files into the quality queue for triage by someone other than the reporter.

## (f) Stage 2 transaction (delivered)

Purchasing starts a sourcing request, picks pathway A, B or C, and records a risk assessment; the system generates a proportionate checklist that is satisfied with files or waived with authority. Engineering authors a baseline revision (company drawing, supplier specification, or supplier base + PDI delta) and a different person releases it. Quality decides a site qualification recorded by someone else. The exact source (part + supplier + site + supplier part + governing revision) collects supplier acknowledgment and FAI samples; a rejected first article stays on record and the resubmission needs a corrective rationale. Management sees every gate with a plain explanation and a link to fix it, and can approve only when none fails. The decision freezes a hashed manifest and produces the approval record PDF. Suspending the supplier or site later marks the source SUSPENDED without touching the decision, and a reasoned reinstatement restores it.

## (g) Stage 3 transaction (delivered)

An inspector records an uncoated ring with a photo and raises a concern; quality triages it and someone other than the reporter confirms an NCR that carries the same identity and photos. The affected lot, quantity and serials are recorded; management authorizes containment and an inspector verifies the physical hold. Management decides dispositions per quantity — return, scrap, rework, repair, or use as is under a current concession for that lot — and someone else verifies each with objective evidence (a same-lot reinspection for rework; a replacement lot is refused). Verified usable material is released by someone other than the decider, and the NCR closes while its SCAR stays open. The supplier's 8D-style response is recorded as its position; PDI verifies implementation and, independently, effectiveness on later production. A later recurrence reopens the SCAR and shows the full FAI and approval history. Supplier promises are tracked with reminders and escalation until PDI verifies them, and supplier or PDI changes move through impact, decision, effectivity and first-lot verification, flagging affected approved sources until requalified. Form revisions are edited, reviewed and released without touching completed inspections.

## (h) Stage 4 transaction (delivered)

A technician uploads a bench file in the interim layout. The original is stored, each test is added once, and the import report explains every skipped, conflicting or excluded test; new serials are registered automatically. The injector's chronology shows the machine verdict next to the PDI evaluation against released criteria. A failing injector gets a repair case with an adjustment and quick measurements, a retest attributed to that action, and closure. Quality compares injectors (first → latest values, CSV or PDF), freezes a shipment evaluation that lists exceptions without releasing material, and reviews first-pass and post-repair yields with their denominators. Management opens Reports for a period: throughput and outcomes with drill-down to exactly the counted inspections, defect types, supplier quality, open and overdue corrective actions, expiring evidence, changes, approval decisions, recurrence and injector performance, then exports CSVs or issues a frozen management report PDF. Anyone with read access can trace a lot or serial and see what requirements and source approval applied on a given date.

## (i) Stage 5 finishes (delivered)

Every API route is exercised without a session, without the CSRF token and as a read-only user, and every refusal is audited. Simultaneous requests cannot create two open repair cases, concerns or drafts, a tampered completed record is refused by the database, and a corrupted photo stops its report with an actionable message. An administrator can take an application-consistent backup and prove it restores completely into an isolated database and disk; a database-only backup is reported incomplete. Every screen passes an automated WCAG A/AA audit at desktop and phone width, an inspection can be started and answered by keyboard alone, and a crawler follows every visible link. Screen and report baselines catch unintended visual changes, and the main read paths stay fast with fifteen years of fictional history.

