# Supplier agreements and controlled quality specifications — architecture

Owner request, 12 Nov 2026. The feature extends TQM. It is not a separate contract system. This note records what was reused, what was extended, the few genuinely new concepts, and the decisions that stay with PDI.

## Inventory: reuse, extend, new

| Need | Existing capability | Decision |
|---|---|---|
| Supplier identity, legal entity, sites | `supplier`, `supplier_site` (immutable UUIDs), supplier detail page | **Reused.** Agreements reference `supplier.id` and `supplier_site.id`. The legal-entity name is snapshotted on the agreement, so renaming a supplier never breaks history. |
| Controlled documents and revisions | Document Library (`controlled_document`, immutable `controlled_document_revision` holding the original PDF and SHA-256, effective dating) | **Reused, extended.** See the Document Library extensions below. |
| Supplier Quality Agreement | SUP-03, a controlled document type and a category-B controlled record with external signatures | **Reused as a layer.** SUP-03 is incorporated into a package by exact revision. A package that incorporates it is that SQA's approval and execution (one path), and a separate SUP-03 record is refused while one is open or executed. Existing SUP-03 records are unchanged. |
| Part-specific requirements (Annex A) | Technical baselines (`technical_baseline`, `baseline_revision`, `baseline_characteristic`): per-part, revision-controlled, released by Engineering, frozen on release, already driving FAI, receiving inspection, acknowledgments and change control | **Reused as Layer C.** See the baseline extensions below. |
| Supplier acknowledgment | `supplier_acknowledgment` (exact baseline revision, transmission, response, representative, evidence) | **Extended**, not duplicated. See the acknowledgment extension below. |
| Approvals, independence, audit | Capabilities, POL-01 independence, `audit_event`, `recheckCapability` | **Reused.** `supplier.manage` prepares, records execution and sends acknowledgments. `supplier.qualify` approves internally (independent of preparer and submitter) and terminates. `documents.control` classifies documents and manages categories. |
| Files and evidence | `file_object`, `evidence_link`, verified storage | **Reused** for signed agreements, correspondence and exhibits (`entity_type = 'SUPPLIER_AGREEMENT'`). |
| Generated PDFs | `report_snapshot` / `report_rendition` and the job queue | **Reused** (`subject_type = 'SUPPLIER_AGREEMENT'`, job `agreement_package`). |
| Tasks | `work_item` and My Work | **Reused** with new kinds `AGREEMENT_REVIEW`, `AGREEMENT_EXECUTION`, `AGREEMENT_REVISION_REVIEW`. |
| Agreement package and its manifest | none | **New**: `supplier_agreement`, `supplier_agreement_site`, `supplier_agreement_document`, `supplier_agreement_signature`. |
| Specification classification, categories, clauses | none | **New**: `document_classification`, `specification_category`, `document_clause`. |

Document Library extensions:

- **Revision labels** may contain a dot (`1.0`). Coded documents outside the Appendix B registry, such as `SCS-001` or `MSA-001`, import as kind `SPECIFICATION`, not `FORM`. Existing rows are unchanged.
- **`document_classification`** marks a document as one of `MASTER_AGREEMENT`, `QUALITY_AGREEMENT` or `TECHNICAL_SPECIFICATION`. Each row carries:
  - a category from the configurable `specification_category` table;
  - applicability rules (product families, materials, manufacturing processes);
  - a default contractual precedence.
- **Clauses**: `document_clause` lists the clauses of an exact revision, so characteristics, inspections and NCRs can cite them.

Technical baseline extensions:

- **Governing specification**: a baseline revision may name its governing specification revision (`governing_spec_revision_id`).
- **Schedule fields** (`schedule`): material, process, identification and logo requirements, additional inspection requirements, authorized exceptions.
- **Clause references**: each characteristic may carry `spec_reference`, e.g. `SCS-001 §6.3`.
- **Photographs and annotated drawings** attach to the baseline revision as evidence.
- **Freezing**: all of these freeze on release under the existing guard.

Acknowledgment extension:

- An acknowledgment may now concern either a baseline revision of a source or a controlled document revision for a supplier (optionally one site).
- New fields: supplier, site, document revision, exceptions.
- Acknowledgments stay revision-specific and remain distinct from compliance.
- When an executed agreement incorporates the same exact revision, the supplier record shows acceptance through the agreement and asks for no second signature.

## The three layers in one package

`supplier_agreement` (kind `AGREEMENT`, `AMENDMENT` or `RENEWAL`) always belongs to one supplier. It carries:

- covered sites (`supplier_agreement_site`);
- product families;
- dates and exceptions;
- a manifest of incorporated documents (`supplier_agreement_document`).

Each manifest line references exactly one of:

- a Document Library revision: the master agreement, the quality agreement or a specification;
- a technical baseline revision: a part schedule (Annex A);
- an exhibit file.

Each line also carries:

- the SHA-256 of the incorporated revision;
- its precedence;
- its contractual reference (e.g. "Schedule B");
- its applicability (sites, parts, product families);
- for amendments, an action: `INCORPORATE`, `REPLACE` or `REMOVE`.

## Applicability and recommendations

- **Recommendations.** For the supplier's covered sites, the builder recommends:
  - the current master agreement;
  - SUP-03 (if in force);
  - every technical specification whose applicability matches the product family, material or process of a part supplied from those sites (exact sources);
  - the released baselines of those sources (part schedules).
- **Review.** The user reviews, adds or removes lines before submission. Nothing is incorporated without review.
- **Precedence conflicts** are detected, never resolved silently:
  - two revisions of the same document with overlapping applicability;
  - two specifications of the same category for the same parts or families;
  - equal precedence across different roles.

  The approver must record a resolution statement for each package that has conflicts.

## Lifecycle

```
DRAFT ──submit──▶ IN_REVIEW ──approve (supplier.qualify, independent)──▶ AWAITING_EXECUTION ──record execution──▶ EXECUTED
  ▲                   │ return (new cycle)                                     │ cancel                         │ terminate ▶ TERMINATED
  └───────────────────┘                                                         ▼                                │ superseded by renewal/replacement ▶ SUPERSEDED
                                                                             CANCELLED                           │ expires_on passed ▶ shown as EXPIRED
```

- **Approval** freezes the manifest (immutable lines plus a SHA-256 over them) and generates the PDI-branded package PDF:
  - a cover with scope;
  - a document index with precedence;
  - the manifest table;
  - an approval and execution page;
  - every incorporated controlled PDF appended page for page from its stored original (originals are never altered).
- **Internal approval is not execution.** Execution is recorded separately from the signed agreement:
  - a signed PDF must be attached;
  - the PDI signatory and supplier signatory are attested by name, title and date;
  - the effective date is entered.

  This is attestation from the signed document; it is not a claim of legal electronic signature.
- **Executed agreements are immutable** (database guard). Corrections, renewals and amendments are separate, linked records.
- **Amendments** carry only the changed lines and apply to their parent once executed.
- **A renewal or replacement** supersedes the earlier agreement and its amendments when executed.

## Revision impact

Releasing a new revision of a classified document never changes an executed package. TQM:

- opens an `AGREEMENT_REVISION_REVIEW` work item for each executed agreement that incorporates an earlier revision;
- lists the affected suppliers, sites, parts and families;
- lists outstanding acknowledgments and exact sources (receiving plans) to review;
- shows that list on the document page.

Amending an agreement is a deliberate act.

## Operational traceability

`governingRequirements(supplier, site, part, date)` resolves the executed, unexpired agreements covering a site and the lines applicable to a part, with clauses. The result is used in:

- **Receiving inspection**: snapshotted into the inspection when it is launched (`inspection.specification_snapshot`) and shown on the workbench. Pass/fail criteria still come only from released baseline characteristics.
- **First article**: snapshotted at registration (`fai_sample.specification_snapshot`) and shown with the sample; characteristics show their clause references.
- **NCRs**: the governing document revision, clause and part schedule (`ncr.governing_*`) are recorded on the NCR, shown with the NCR and its SCARs, and carried into OPS-06.
- **Exact sources**: the source page shows contractual coverage. It is informational and adds no new approval gate.

## Interfaces

- **Supplier record:** Suppliers → supplier → **Agreements & Specifications** (primary location).
- **Agreement page:** `/agreements/:id`.
- **Document page:** classification, clauses, incorporated in, revision impact.
- **Part page:** governing specifications per exact source, material and process.
- **Source page:** contractual coverage (informational).
- **Inspection workbench:** applicable controlled requirements.
- **FAI:** specifications at receipt.
- **NCR:** governing requirement.
- **SCAR:** the NCR's requirement.
- **Baseline:** part-specific schedule and clause references.

**API**

- Specifications and documents:
  - `GET/POST/PATCH /api/specification-categories`
  - `GET /api/specifications`
  - `PUT /api/documents/:id/classification`
  - `POST /api/document-revisions/:id/clauses`
  - `GET /api/documents/:id/impact`
  - `GET /api/parts/:id/specifications`, `PUT /api/parts/:id/classification`
- Suppliers:
  - `GET/POST /api/suppliers/:id/agreements`
  - `POST /api/suppliers/:id/acknowledgments`
  - `POST /api/suppliers/:id/status`
- Agreements:
  - `GET/PATCH /api/agreements/:id`
  - `PUT /api/agreements/:id/documents`
  - `GET /api/agreements/:id/recommendations`
  - `GET /api/agreements/:id/preview.pdf`
  - `POST /api/agreements/:id/{submit,return,approve,execution,terminate,cancel,amendments,renewal}`
- NCRs: `PUT /api/ncrs/:id/requirement`
- Reused unchanged: attachments use `POST /api/evidence/SUPPLIER_AGREEMENT/:id`; responses use `POST /api/acknowledgments/:id/response`.

## Decisions that stay with PDI

- **The legal text of the Master Supplier Agreement.** TQM ships only a clearly marked proposed structure (`MSA-001`, synthetic). PDI counsel must supply and approve the real text.
- **Precedence language and amendment procedure wording.**
- **SCS-001 Rev 1.0.** The approved file was not available, so the pilot uses a clearly marked synthetic SCS-001 with revision labels `S1.0` and `S1.1`. Import the approved file through **Documents → Import** as `SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.0.pdf` (effective today or later). It becomes an ordinary new revision and opens revision reviews on the pilot agreements.
- **Acceptance criteria for casting checks** (porosity classes, sampling). These are not invented. They become baseline characteristics only when Engineering releases them.
- **Whether an executed agreement becomes a source-approval gate.** Today coverage is shown, not enforced.
