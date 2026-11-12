# One approval path per event — release note and migration notes

## Release note

Controlled forms are now the approval record of the module events they describe. Each event has one approval sequence: its module decision. That decision drives the operational outcome and signs the controlled PDF.

- **The form opens with the event.** Each event below opens its controlled record in the same transaction. The record binds the base form and the continuation, evidence and narrative revisions in force at that moment. If no interactive revision of the form is in force, the event is recorded as before, without one.

| Event | Form | Opens when | Submitted by | Signed before the decision (concurrence) | Decided by (signs the PDI decision) |
|---|---|---|---|---|---|
| Receiving inspection | OPS-02 | the inspection is launched | completing the inspection | — | **Confirm review** (Receiving Quality approver) |
| Nonconformance | OPS-06 | the NCR is confirmed | the preparer (**Submit for decision**) | Engineering, only when a repair or use-as-is disposition was decided | **Close NCR** |
| Concession | OPS-05 | the concession is requested | the preparer | Engineering approver | **Decide concession** (Supplier Quality approver block) |
| Supplier corrective action | OPS-07 (and an OPS-08 8D started from the SCAR) | the SCAR is issued, or reopened by a recurrence after closure | the preparer | Engineering on an 8D, optional | **Close SCAR** |
| First article | VAL-02 | the sample is registered | the preparer | Engineering approver | **Decide first article** |
| Source approval | VAL-11 | approval of the source is requested | the preparer | Engineering approver | **Source decision** |
| Change request | OPS-04 | the change is proposed | the preparer | Engineering approver | **Decide change** |
| Sourcing request | INT-01 | the request is started | the preparer | Engineering / Quality approver | the form's own **PDI decision**; a rejection cancels the sourcing request |

- **No second approval.** The module's approval block cannot be signed on the controlled record: the record shows where it is signed, and the API refuses it. The module decision is refused until three things hold: the form is complete and submitted; the concurrence blocks are signed (or not required); and the decider is independent of the preparer, the submitter and anyone else who signed (POL-01).
- **No duplicate entry.** Facts the module holds appear on the form locked, marked "From the …". They include supplier, site, part, baseline, lots and quantities, inspection readings, first-article results, NCR containment and dispositions, concession lots, and the SCAR's response and verifications. Rows that come from the module, such as readings, scopes and characteristics, cannot be added or removed on the form. Entries only the form needs, such as equipment IDs, verification references and sampling basis, stay attached to their module row.
- **Stale facts stop the decision.** If the module record changes after the form is submitted, its decision is refused until the form is returned to draft and submitted again. Examples: a disposition is decided, or results are edited. A returned form starts a new approval cycle, and earlier signatures stay on record.
- **Cancel and withdraw.** Withdrawing a concession or cancelling a change or sourcing request voids its open form. The form cannot be voided on its own, so an event cannot lose its approval path.
- **Receiving inspections.** With OPS-02 in force, completing an inspection also submits OPS-02. Every lot, including a passing one, then goes to an independent review: the review confirmation is the lot decision (PASS/ACCEPTED → "Accept lot", FAIL → "Hold"). A review return sends OPS-02 back to draft with the inspection.
- **Legacy PDFs demoted.**
  - The app-designed NCR, concession, SCAR and change summaries, injector reports and the summary source-approval record now print "SUMMARY REPORT - NOT A CONTROLLED DOCUMENT" and no longer show a document code such as OPS-06 on their masthead or footer. Their buttons read **Issue summary PDF (not controlled)**.
  - An event with a controlled record issues no summary: its controlled PDF is the output, and VAL-11 replaces the summary approval record.
  - The inspection report PDF of an inspection with a completed OPS-02 is labelled "INSPECTION WORKSHEET - NOT THE CONTROLLED RECORD" and names the OPS-02 record.
  - Editions issued earlier are unchanged and stay listed as "Summary edition N" for traceability.
- **Narrative continuation.** Several short overflows (an identifier wider than its box) now share one narrative sheet, each under the label and field it continues. A two-item OPS-02 is 5 pages instead of 14. Long text still continues on sheets of its own.
- **Records from before this release** keep exactly what was recorded. Existing controlled records, signatures and PDFs are unchanged.
  - An open record of one of these types started before this release (not bound to its event) takes no further approval: the record page says so and offers Void.
  - An event that is still open but has no form can have one started from its module page, bound to the revision in force today.
- **Test environment.** `render-test.yaml` defines a separate Render test environment (own database and document disk, auto-deploy from `main`). `PILOT_SEED` loads fictional pilot records once. See [TEST_ENVIRONMENT.md](../construction/TEST_ENVIRONMENT.md). The environment shows a **TEST** badge, and nothing in it is a production release.

The approved Rev 03 templates still print "DRAFT - NOT RELEASED" and "Effective: pending". TQM reproduces them exactly, so generated records carry that text until PDI releases final revisions.

## Migration notes

**Migration `0013_controlled_event_binding.sql`** is additive. It needs no backfill and no downtime beyond the normal deploy.

| Change | Purpose | Effect on existing data |
|---|---|---|
| `controlled_record.event_bound boolean NOT NULL DEFAULT false` | Marks the record a module event opened | Existing records get `false` and stay exactly as recorded |
| Unique index `controlled_record_open_event_idx` on `(type_code, entity_type, entity_id)` where `event_bound` and status is DRAFT or SUBMITTED | At most one open record of a type per event; completed and void records remain, so a reopened event opens a new one | Applies only to event records, so no existing row is affected |
| `controlled_record_signature.module_action text` | Names the module decision that signed a block, e.g. `concession.decide` | NULL for earlier signatures |
| `controlled_record_guard()` replaced | `event_bound` joins the immutable identity of a record | Same rules otherwise |

Registry changes in `src/shared/controlled-forms.ts`:

- VAL-02 now belongs to the first-article sample (entity `FAI`) instead of the source. Earlier VAL-02 records keep entity `SOURCE` and stay readable.
- OPS-06's deciding block is signed by the NCR closer (`ncr.manage`).
- OPS-07 and OPS-08 are signed by the SCAR closer (`scar.close`).
- `EVENT_BINDINGS` lists the event, submit action, module decision and concurrence rules shown above.

Deploy:

1. Deploy as usual. The pre-deploy `migrate` applies 0013.
2. Events created from then on open their forms automatically, for every type whose controlled form is in force.
3. Optional clean-up: open records listed as "started before … was bound" can be voided. They take no approval.

Rollback: rolling the application back leaves the new column and index unused. Do not roll back while event records are open. The earlier application would offer each event record's module block for signature on the record, which is a second approval path. Complete or void them first.

New environment variables, all optional and ignored in production:

- `ENVIRONMENT_LABEL` (badge text, e.g. TEST)
- `PILOT_SEED`
- `PILOT_TEMPLATES_DIR`

See [TEST_ENVIRONMENT.md](../construction/TEST_ENVIRONMENT.md) for the full list.

Tests:

- `tests/integration/controlled-events.test.ts` proves the single path for inspection, concession, change, first article, source approval, SCAR and sourcing request.
- `tests/integration/controlled.test.ts` covers OPS-06 end to end (continuations, narrative, revision binding, stale facts, return cycles).
- `tests/integration/pilot-seed.test.ts` covers the pilot seed.
- `tests/e2e/controlled-forms.spec.ts` drives one complete record per family through the UI and its module decision, then validates the PDF against the bound revision.
- The controlled specs run in their own Playwright project after the module walkthroughs, which exercise the modules with no controlled form in force.
