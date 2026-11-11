# Controlled documents drive the work — release note and migration notes

## Release note

The controlled PDFs in the Document Library now define the data-entry screens and the generated records.

- **One workflow per record.** Each of the 37 registered document types belongs to a module (sourcing requests, suppliers, exact sources, changes, inspections, concessions, NCRs, SCARs, the Document Library). A **Controlled forms** panel on the module record starts the document from the approved revision in force, prefilled from the module data (supplier, site, part, baseline, lots, NCR containment, inspection and first-article measurements, concession lots, baseline requirements, SCAR content).
- **Category A (28 types): completed in TQM.** The entry screen is derived from the AcroForm field tree of the released PDF: sections, labels, required/conditional/optional marks, choice values, length limits and printed checklist rows. Sections expand as needed; rows beyond what a sheet holds continue on the matching continuation sheet, text longer than a field continues on the narrative continuation, and the evidence index lists attached files (with SHA-256) and every continuation sheet. Submission checks every required entry. Approval uses the form's own approval block, independently of the preparer and submitter (POL-01), with the PDI decision recorded by the deciding approver; "when required" approvals can be marked not required. Completion generates one controlled PDF: the approved revision filled in and flattened, followed by its continuation sheets.
- **Category B (9 types): attached documents.** Legal instruments (SUP-03, SUP-04), supplier-authored submissions (SUP-05, VAL-06 to VAL-10) and the library's own rules (SYS-01) stay external evidence. The record binds the template revision in force, checks whether each attached PDF is that template filled in, and completes only when every required acknowledgment or signature is recorded: in-app signatures by authorized users, and external signatories attested from the executed document.
- **Revision binding.** A record binds its base form and every continuation, evidence and narrative sheet revision in force when it is opened. Later revisions never change it or its PDF; new records use the new revision.
- **Validated output.** Every generated PDF is checked against the bound template revisions before it is stored: page sequence and sizes, the template's static page content carried over byte for byte (layout, headings, document-control band and footer), document control on every page, every entered value, signature and sheet ID visible on its page, no remaining form fields and no dangling references. The result is shown with the PDF.
- **Document Library** shows each type's handling (A or B), its module, and the structure derived from the current revision. Importing a revision derives its template; a PDF without fields imports as a reference only.

Not included: superseding revisions of a completed record (corrections are a new record), editing the type-to-module mapping in the app, and replacing the existing app-designed PDFs (inspection, NCR, concession, SCAR, change, approval and injector reports continue unchanged alongside the controlled output).

The approved Rev 03 templates themselves still print "DRAFT - NOT RELEASED" and "Effective: pending". TQM reproduces the approved revision exactly, so the generated records carry that text until PDI releases revisions with final status text.

## Migration notes

**Migration `0012_controlled_forms.sql`** is additive: no existing table, column or row changes.

| New table | Purpose | Protection |
|---|---|---|
| `controlled_template` | Template definition derived from one released revision | immutable |
| `controlled_record` | One controlled record, bound to the base revision in force when opened | identity and revision binding immutable; data locked once submitted; frozen when completed or void; no deletes |
| `controlled_record_binding` | Every revision a record is bound to (base, continuation, evidence, narrative) | immutable |
| `controlled_record_signature` | Approvals (A) and required signatures (B), per approval cycle | immutable |
| `controlled_output_validation` | Validation result for each generated PDF | immutable |
| `controlled_attachment_check` | Whether an attached PDF is the bound template filled in | immutable |

Existing tables are reused, not changed: generated PDFs are `report_snapshot`/`report_rendition` rows with `subject_type = 'CONTROLLED_RECORD'`; attached files are `evidence_link` rows with `entity_type = 'CONTROLLED_RECORD'`; record numbers use `record_sequence` with the document code as prefix (e.g. `OPS-06-2026-00001`); rendering uses the job queue (`controlled_render`).

Deploy steps:

1. Deploy the image. The pre-deploy step runs `migrate` as before; migration 0012 needs no data backfill and no downtime beyond the normal deploy.
2. Nothing else is required. Templates for revisions already in the Document Library are derived on first use and stored; newly imported revisions are derived at import.
3. To enable a category-A type, its controlled form PDF must be in effect in the Document Library (the owner's Rev 03 set). Continuation sheets, `PDI_Evidence_Continuation` and `PDI_Narrative_Continuation` must be imported for records that need more rows or longer text than the form holds; submission explains which sheet is missing.

Backups: the six new tables are counted in `TQMS-BACKUP-1` manifests. Verifying a backup taken before this release still works: tables absent from the restored schema are no longer counted.

Rollback: the release adds tables only. Rolling back the application leaves them unused; existing records, PDFs and the Document Library are unaffected. Do not drop the tables once records exist (they hold controlled records).

New dependency: `pdf-lib` 1.17.1 (pure JavaScript; reads, fills, flattens and assembles the controlled PDFs). `npm audit` reports no new findings for it.

Tests: the approved PDFs are PDI-controlled and are not committed. `tests/fixtures/controlled-templates.json` records their structure and SHA-256 (`npx tsx scripts/controlled-templates-fixture.ts <folder>` regenerates it after new revisions); CI uses stand-ins rebuilt from it. `CONTROLLED_DOCS_DIR=<folder> npx vitest run tests/unit/controlled-approved.test.ts` checks the fixture against the real files and renders every category-A form on them.

## Document type mapping

A = completed in TQM with generated controlled PDF; B = attached document with required acknowledgments or signatures. Capabilities are the authorities that may sign each approval block.

| Code | Document | | Module | Approvals / required signatures |
|---|---|---|---|---|
| INT-01 | Product Sourcing Request (PSR) | A | Sourcing requests | approver1: sourcing.manage; approver2: engineering.release or supplier.qualify |
| INT-02 | Sourcing Path & Risk Assessment (SPRA) | A | Sourcing requests | approver1: engineering.release; approver2: supplier.qualify |
| SUP-01 | Supplier Qualification Questionnaire (SQQ) | A | Suppliers | approver1: supplier.qualify |
| SUP-02 | Supplier Capability / Process Assessment (SCA) | A | Suppliers | approver1: supplier.qualify; approver2: engineering.release |
| SUP-03 | Supplier Quality Agreement (SQA) | B | Suppliers | Legal approval, PDI signatory and supplier signatory (attested from the executed agreement); Quality approver (supplier.qualify) |
| SUP-04 | Non-Disclosure Agreement (NDA) | B | Suppliers | Legal approval, PDI signatory and supplier signatory (attested); Authorized PDI representative (supplier.qualify) |
| SUP-05 | Sub-tier / Critical Process Disclosure | B | Suppliers | Supplier disclosure acknowledgment (attested); Engineering (engineering.release); Supplier Quality (supplier.qualify) |
| ENG-01 | Customer-Controlled Drawing / TDP Checklist | A | Exact sources | engineering.release; supplier.qualify |
| ENG-02 | Design Review & Engineering Release | A | Exact sources | engineering.release; supplier.qualify |
| ENG-03 | Physical Sample / Reverse Engineering Intake | A | Exact sources | engineering.release; validation.decide |
| ENG-04 | Supplier Baseline Product Specification | A | Exact sources | engineering.release; supplier.qualify |
| ENG-05 | Supplier Part Cross-Reference & Configuration Record | A | Exact sources | engineering.release; sourcing.manage or supplier.qualify |
| ENG-06 | Customer-Specific Requirements / Delta Specification | A | Exact sources | engineering.release; supplier.qualify |
| ENG-07 | Altered / Selected Item Drawing | A | Exact sources | engineering.release; supplier.qualify |
| ENG-08 | Critical Characteristics & Acceptance Matrix | A | Exact sources | engineering.release; supplier.qualify |
| ENG-09 | Specification / Revision Change Record | A | Changes | engineering.release; supplier.qualify |
| VAL-01 | Product Qualification & Validation Plan | A | Exact sources | engineering.release; validation.decide |
| VAL-02 | First Article Inspection Report | A | Exact sources (first articles) | engineering.release; validation.decide |
| VAL-03 | Functional / Performance Test Report | A | Exact sources | engineering.release; validation.decide |
| VAL-04 | Material / Coating / Special Process Certificate Checklist | A | Exact sources | engineering.release; validation.decide |
| VAL-05 | PPAP Applicability & Submission Requirements | A | Exact sources | validation.decide; engineering.release |
| VAL-06 | Part Submission Warrant (PSW) | B | Exact sources | Supplier authorized representative (attested); Supplier Quality (validation.decide); Engineering (engineering.release) |
| VAL-07 | Process FMEA | B | Exact sources | Supplier PFMEA owner (attested); Manufacturing / Engineering (engineering.release); Supplier Quality (validation.decide) |
| VAL-08 | Production Control Plan | B | Exact sources | Supplier process owner (attested); Supplier Quality (validation.decide) |
| VAL-09 | Measurement System Analysis | B | Exact sources | Metrology approver (attested); Supplier Quality (validation.decide) |
| VAL-10 | Process Capability / SPC Study | B | Exact sources | Qualified statistical reviewer (attested); Supplier Quality (validation.decide) |
| VAL-11 | Product & Supplier Approval Record | A | Exact sources (approval) | engineering.release; source.approve |
| OPS-01 | Incoming Inspection Plan | A | Exact sources (receiving plan) | forms.publish |
| OPS-02 | Incoming Inspection Report | A | Incoming inspections | inspection.review |
| OPS-03 | Supplier Product / Process Change Request | A | Changes | change.approve |
| OPS-04 | Change Impact & Requalification Decision | A | Changes | engineering.release; change.approve |
| OPS-05 | Temporary Deviation / Concession Request | A | Concessions | engineering.release; concession.approve |
| OPS-06 | Nonconformance Report | A | Nonconformance reports | material.disposition; engineering.release when required |
| OPS-07 | Supplier Corrective Action Request | A | Supplier corrective actions | scar.verify |
| OPS-08 | Structured Problem-Solving Report (8D) | A | Supplier corrective actions | scar.verify; engineering.release when required |
| OPS-09 | Supplier Performance Scorecard | A | Suppliers | supplier.qualify; sourcing.manage |
| SYS-01 | Document Type / Retention & Approval Rules | B | Document Library | Quality Systems (documents.control); Legal / process owners (attested) |

Category A applies where PDI authors the record and its content drives TQM work; category B where the document is executed or authored outside PDI (legal instruments, supplier declarations and supplier-computed analyses) or governs the library itself. The mapping and signing authorities are in `src/shared/controlled-forms.ts` and are PDI decisions to confirm (POL-01, POL-07).
