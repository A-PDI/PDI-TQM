# TQMS design baseline (Stages 0–4)

Source: *PDI TQMS Zero-to-Production Construction Set* (20 Oct 2026). The authoritative requirements are copied verbatim in [`requirements/`](requirements) and the construction drawings in [`construction/`](construction). This file covers items (a)–(e) of the master prompt's Part XI response contract.

Status vocabulary (Drawing F1): **implemented** → **unit-tested** → **integration-tested** → **UI-tested** → **staging-tested** → **PDI-approved** → **production-released**. Nothing here is beyond UI-tested. Nothing has been deployed to Render, and no real data has been used.

## (a) Implementation plan mapped to P0 and acceptance tests

| Stage | Scope | AT cases | State |
|---|---|---|---|
| 0 Foundation | identity, grants, sessions, CSRF, audit, numbering, evidence disk, jobs, migrations, health/readiness, Docker | AT-19 (part), AT-21 (part), NEG-10/11/12/13/14* | **Built in this PR** (*NEG-14 needs backup tooling, Stage 6) |
| 1 Inspector's room | Appendix A catalogue, launch, multi-unit workbench, all specialized patterns, photos, partial/complete, independent review, amendments, branded PDF, linked concern + triage | AT-01, AT-02 (part), AT-03 (part), AT-04, AT-06 (part) | **Built in this PR** |
| 2 Supplier/engineering | site qualification, A/B/C sourcing, baseline release workflow and UI, FAI reject/resubmit, supplier acknowledgment, source approval with frozen manifest | AT-09–AT-13, AT-17, NEG-04, NEG-05 | **Built (Stage 2 PR)** |
| 3 Quality/change | NCR scope/containment/disposition/verification/release, concession, SCAR/8D/effectiveness/recurrence, supplier commitments with reminders, change control, form-revision editor and one-off forms, OPS-03/04/05/06/07/08 PDFs | AT-02, AT-03, AT-06, AT-07, AT-08, AT-12 (concession gate), AT-14–AT-16, AT-18, NEG-01, NEG-06–08, NEG-17, NEG-18 | **Built (Stage 3 PR)** |
| 4 Injector & management | serialized injectors, idempotent bench-file import (interim adapter), manual tests, repair cases with quick measurements, retest attribution, comparison, shipment evaluation, injector analytics; management overview with shared metric definitions, drill-down, CSV exports, issued management report PDF; traceability by part + lot or serial | AT-05, AT-20, NEG-09, NEG-22 | **Built (Stage 4 PR)** |
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
| POL-01 | Authority grants and independence exceptions | Capabilities granted per person. Inspection reviewer ≠ inspector; baseline and form releaser ≠ author/submitter; qualification decider ≠ assessor; FAI decider ≠ recorder/measurer; source approver ≠ sourcing request owner; NCR confirmer ≠ concern reporter; concession approver ≠ requester; material releaser ≠ disposition decider; SCAR effectiveness verifier ≠ implementation verifier; change approver ≠ requester; no exception path |
| POL-02 | Acceptance limits, units, methods, CTQ, effectivity | Without a released baseline limit, readings are observations and need Engineering review; no PASS is calculated |
| POL-03 | Sampling/AQL, lot handling, release with missing baseline | Sample size is entered by hand; completing an inspection never releases material |
| POL-04 | Risk method, assessment/FAI/PPAP triggers, SCAR/suspension criteria, response due dates | `RISK-INTERIM-1` and `CHECKLIST-INTERIM-1` as in Stage 2. SCAR effectiveness needs a completed, non-failing inspection received after implementation was verified, or a documented alternative with evidence. `REMINDER-INTERIM-1`: overdue commitments get a daily in-app reminder; HIGH escalates to management at once, MEDIUM after 7 days, LOW is only reminded. E-mail stays disabled |
| POL-05 | Concessions, containment, partial release, physical verification | `DISPOSITION-INTERIM-1`: containment authorized by management and physically verified on site; disposition per quantity/serial; use-as-is only under a current approved concession for the same part and lot within its quantity; rework/repair verified only by a PDI reinspection of the same lot showing the failed characteristic conforms; release by someone other than the decider; no ERP stock movement |
| POL-06 | Change effectivity, old lots, requalification | Impact assessment before decision; a site change always requires requalification; effectivity needs the new baseline revision released (optional first lot); implementation is verified by a completed, passing inspection of an affected source on or after the effective date under the changed revision; earlier lots keep their recorded revision |
| POL-07 | Signature format, brand artwork/fonts/colors, numbering, retention | Reference logo extract + suggested navy tokens; `IR-`/`QE-`/`NCR-`/`DEV-`/`SCAR-`/`COM-`/`CHG-`/`BI-`/`REP-`/`SHP-`/`CMP-`/`MR-YYYY-NNNNN`; the management report uses the uncatalogued code `TQMS-MR`; controlled record PDFs issued as numbered editions; nothing destructively deleted |
| POL-08 | Injector bench formats and rules | Interim synthetic layout `TQMS-BENCH-CSV-1` (one row per measured value; labelled *not a CarbonZapp format*). No bench integration. A PDI verdict is calculated only from released FUNCTIONAL baseline characteristics referenced `injector:<condition>__<parameter>`, compared exactly and only in the same unit; otherwise the result is NO_CRITERIA / PARTIAL_CRITERIA and the machine verdict is shown separately, never as a PDI verdict. Must be validated against real bench files before production |
| POL-09 | Render budget/sizing, monitoring owner, RPO/RTO, off-site backup, MFA, launch gate | Local + template only; nothing provisioned |
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

## (d) Acceptance matrix (current state)

Test files: `U` = `tests/unit/domain.test.ts`, `I` = `tests/integration/inspection.test.ts`, `R` = `tests/integration/reports.test.ts`, `S` = `tests/integration/sourcing.test.ts`, `Q` = `tests/integration/quality.test.ts`, `E` = `tests/e2e/inspection.spec.ts`, `E2` = `tests/e2e/sourcing.spec.ts`, `E3` = `tests/e2e/quality.spec.ts`, `J` = `tests/integration/injectors.test.ts`, `M` = `tests/integration/management.test.ts`, `UJ` = `tests/unit/injectors.test.ts`, `E4` = `tests/e2e/injectors.spec.ts`, `E5` = `tests/e2e/reports.spec.ts`.

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
| AT-19 roles | Partial | I, S independence; Q: inspector cannot disposition (NEG-01), nobody approves their own concession/change/form, release ≠ decider, effectiveness ≠ implementation verifier; J/M: only `injector.test` imports, only `injector.evaluate` freezes shipment evaluations, only `reports.export` exports or issues reports (denials audited) |
| AT-20 traceability | UI-tested: part + lot or serial returns inspections (form/spec revision, photos, flagged rows), FAI defects, NCR/disposition/concession/change history, bench history, and what applied on a chosen date; search also finds injectors, bench imports and documents by file name | M "AT-20…", J search, E4 trace |
| AT-21 failure recovery | Partial: unsaved-entry restore, upload failure message, report-job reclaim, redeploy persistence; **backup/restore not built** | E "AT-21", I "report job recovery", Docker redeploy check |
| NEG-01 | Integration-tested: inspector calling the disposition API is denied and audited; no decision recorded | Q |
| NEG-02, NEG-03 | Integration-tested | I |
| NEG-10, NEG-11, NEG-12 | Integration-tested (NEG-12 also in Docker) | I, U |
| NEG-13 | Manually verified in Docker (container replaced; PDF/photo hashes and draft unchanged) | milestone report |
| NEG-15 | UI-tested (390 px, 100 items) | E phone test |
| NEG-16, NEG-23, NEG-24 | Integration + unit tested | I, U |
| NEG-18 | Integration-tested: no generic close/status endpoint; SCAR/NCR guarded by triggers | I, Q |
| NEG-19 | Integration-tested | I |
| NEG-20 | By construction: no reference reports or photos in repo/fixtures | `tests/fixtures/images.ts` |
| NEG-21 | UI-tested for built navigation | E navigation test |
| NEG-04 | Integration-tested: sibling site not approved; inspection records the effective state | S Path B |
| NEG-05 | Integration-tested: explicit gate failures with links, no partial approval | S Path A, Path C |
| NEG-06, NEG-07, NEG-08 | Integration-tested | Q |
| NEG-17 | Integration-tested: approved source shows REQUALIFICATION_REQUIRED and the CHANGE_CONTROL gate fails until implementation is verified | Q "AT-16 / NEG-17…" |
| NEG-09 | Integration-tested: same file → DUPLICATE_FILE, nothing added; changed value under the same key → conflict, original unchanged | J |
| NEG-22 | Integration-tested: an import interrupted after the second test leaves every table and the storage object unchanged; re-running imports each test once | J |
| NEG-14 | Not built (Stage 6) | — |

### Functional requirement traceability (Stage 1 scope)

| FR | Where |
|---|---|
| FR-001, FR-111, FR-112 | `src/shared/capabilities.ts`, `src/server/auth.ts`, `audit.ts`, migration 0001 |
| FR-040, FR-041 | `src/web/pages/Inspections.tsx`, `POST /api/inspections` |
| FR-042 | Released catalogue in Stage 1; editor and one-off builder delivered in Stage 3 (see below) |
| FR-043 – FR-051 | `src/web/pages/Workbench.tsx`, `src/shared/inspection.ts`, `src/server/inspections/service.ts` |
| FR-052, FR-053 | `src/server/pdf/inspection-report.ts`, `report-snapshot.ts`, `report-job.ts` |
| FR-054 | `POST /api/inspections/:id/concerns` (`src/server/quality.ts`) |
| FR-055 | form/baseline snapshots + triggers (migration 0003) |
| FR-056 | list status counts share one query definition with the filters |
| FR-011, FR-012, FR-100, FR-101 | `/api/home`, `/api/search`, `QuickCapture.tsx` |
| FR-110 | local accounts, lockout, session revocation; invitation/reset email deferred (email disabled until approved) |
| FR-113 – FR-115 | storage, job worker, readiness, Docker, CI; backup/restore deferred to Stage 6 |

### Functional requirement traceability (Stage 2 scope)

| FR | Where |
|---|---|
| FR-020, FR-021 | `src/server/sourcing/suppliers.ts`, `src/web/pages/Suppliers.tsx`, migration 0004 (`supplier_qualification`, `supplier_certificate`) |
| FR-022 | `supplier_restriction`, `src/server/sourcing/status.ts` (POL-13 interim) |
| FR-023 [P1] | Not built (certificate expiry is stored and shown; no reminders or performance trends) |
| FR-024 – FR-027 | `src/shared/sourcing.ts`, `src/server/sourcing/requests.ts`, `src/web/pages/Sourcing.tsx` |
| FR-028, FR-029 | `src/server/sourcing/baselines.ts`, `src/web/pages/Baseline.tsx` |
| FR-030 | acknowledgments in `src/server/sourcing/sources.ts`, `src/web/pages/Source.tsx` |
| FR-031 | A newer supplier base is flagged on the source; reassessment runs through change control (Stage 3) |
| FR-032 – FR-034 | `source`, `fai_sample`, `fai_result`; `src/server/sourcing/sources.ts` |
| FR-035 | Partial: FAI measured values and results with independent decision; separate test procedures/validation plans are Stage 4 |
| FR-036, FR-037 | `src/server/sourcing/gates.ts`, `source_approval_decision`, `approval-report.ts`, `src/server/pdf/record-report.ts` |
| FR-038 [P1] | Partial: the approval record PDF lists the evidence package; no combined PPAP package export |

### Functional requirement traceability (Stage 3 scope)

| FR | Where |
|---|---|
| FR-007, FR-015 | concern → NCR confirmation (`src/server/quality/ncr.ts`), linked evidence, SCAR, concessions, commitments, changes |
| FR-012 – FR-014 | `src/server/quality/commitments.ts`, `src/web/pages/Commitments.tsx`; reminders via the `reminder_sweep` job |
| FR-016, FR-076 | `src/server/quality/context.ts`; quality/change/commitment card on part, source and supplier hubs; concession shown on inspections |
| FR-042, FR-058 | `src/server/forms/forms.ts`, `src/web/pages/Forms.tsx`; one-off launch in `Inspections.tsx` |
| FR-070 – FR-075 | `src/server/quality/ncr.ts`, `concessions.ts`, `scars.ts`; migration 0005 |
| FR-080 – FR-084 | `src/server/changes/changes.ts`, `src/web/pages/Changes.tsx`; `REQUALIFICATION_REQUIRED` overlay in `sourcing/status.ts` |
| FR-090 – FR-093 | Partial: OPS-03/04/05/06/07/08 controlled PDFs (`src/server/quality/reports.ts`) as numbered editions; no administrative document-type catalogue editor yet |

### Functional requirement traceability (Stage 4 scope)

| FR | Where |
|---|---|
| FR-010, FR-101 | `src/server/reports/trace.ts`, `src/web/pages/Reports.tsx` (Trace); search additions in `routes-core.ts` |
| FR-060 – FR-064 | `src/server/injectors/bench.ts`, `routes.ts`, `reports.ts`; `src/web/pages/Injectors.tsx`; migration 0006 |
| FR-102 – FR-104 | `src/server/reports/metrics.ts`, `routes.ts`, `management-report.ts`; `src/shared/reports.ts`; recurrence by part/supplier/characteristic/failure mode and repeated rejected-FAI defects |
| FR-114 | Partial: imports and report rendering use the monitored job queue; e-mail notifications not enabled |

## (e) First vertical transaction (delivered)

An inspector searches a part (including by OE alias) and launches the suggested released form against an exact source. They answer the shared receiving section once, complete serialized items with checklist answers, measurements (compared against the released synthetic baseline) and row photos, then save, reload and resume. Completion is blocked with exact-path messages until required evidence is present. A failed result goes to an independent reviewer; confirmation freezes the record and a background job renders the branded PDF edition with a stored SHA-256. An authorized amendment adds a new edition and leaves the original untouched. A concern raised from a failed row carries the identity, expected/actual values and the *same* photo files into the quality queue for triage by someone other than the reporter.

## (f) Stage 2 transaction (delivered)

Purchasing starts a sourcing request, picks pathway A, B or C, and records a risk assessment; the system generates a proportionate checklist that is satisfied with files or waived with authority. Engineering authors a baseline revision (company drawing, supplier specification, or supplier base + PDI delta) and a different person releases it. Quality decides a site qualification recorded by someone else. The exact source (part + supplier + site + supplier part + governing revision) collects supplier acknowledgment and FAI samples; a rejected first article stays on record and the resubmission needs a corrective rationale. Management sees every gate with a plain explanation and a link to fix it, and can approve only when none fails. The decision freezes a hashed manifest and produces the approval record PDF. Suspending the supplier or site later marks the source SUSPENDED without touching the decision, and a reasoned reinstatement restores it.

## (g) Stage 3 transaction (delivered)

An inspector records an uncoated ring with a photo and raises a concern; quality triages it and someone other than the reporter confirms an NCR that carries the same identity and photos. The affected lot, quantity and serials are recorded; management authorizes containment and an inspector verifies the physical hold. Management decides dispositions per quantity — return, scrap, rework, repair, or use as is under a current concession for that lot — and someone else verifies each with objective evidence (a same-lot reinspection for rework; a replacement lot is refused). Verified usable material is released by someone other than the decider, and the NCR closes while its SCAR stays open. The supplier's 8D-style response is recorded as its position; PDI verifies implementation and, independently, effectiveness on later production. A later recurrence reopens the SCAR and shows the full FAI and approval history. Supplier promises are tracked with reminders and escalation until PDI verifies them, and supplier or PDI changes move through impact, decision, effectivity and first-lot verification, flagging affected approved sources until requalified. Form revisions are edited, reviewed and released without touching completed inspections.

## (h) Stage 4 transaction (delivered)

A technician uploads a bench file in the interim layout. The original is stored, each test is added once, and the import report explains every skipped, conflicting or excluded test; new serials are registered automatically. The injector's chronology shows the machine verdict next to the PDI evaluation against released criteria. A failing injector gets a repair case with an adjustment and quick measurements, a retest attributed to that action, and closure. Quality compares injectors (first → latest values, CSV or PDF), freezes a shipment evaluation that lists exceptions without releasing material, and reviews first-pass and post-repair yields with their denominators. Management opens Reports for a period: throughput and outcomes with drill-down to exactly the counted inspections, defect types, supplier quality, open and overdue corrective actions, expiring evidence, changes, approval decisions, recurrence and injector performance, then exports CSVs or issues a frozen management report PDF. Anyone with read access can trace a lot or serial and see what requirements and source approval applied on a given date.
