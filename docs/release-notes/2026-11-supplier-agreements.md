# Supplier agreements and quality specifications — release note, migration notes and acceptance

## Release note

Supplier agreements are now managed from the supplier record: **Suppliers → supplier → Agreements & Specifications**. TQM assembles each agreement from controlled documents already in the Document Library, at exact revisions. It is not a separate contract system. The architecture and reuse decisions are in [construction/SUPPLIER_AGREEMENTS.md](../construction/SUPPLIER_AGREEMENTS.md).

### On the supplier record

The **Agreements & Specifications** section shows:

- **Summary:**
  - the current agreement, its master agreement revision and its state;
  - effective and expiry dates, with a *renewal due* flag within 90 days of expiry;
  - the contracting legal entity, the sites and product families covered, and the number of incorporated specifications;
  - counts of agreements awaiting signatures, acknowledgments outstanding and amendments in progress;
  - suspensions, inactivity and exceptions.
- **Agreement lists:** active agreements, drafts and internal review, pending execution, amendments, and historical agreements (superseded, expired, terminated, cancelled).
- **Documents in effect:** the incorporated specifications and the part-specific schedules, with exact revisions.
- **Acknowledgments,** supporting documents (including each signed copy) and the complete audit history.
- **Actions** for those who hold the authority:
  - **New agreement** and **Request acknowledgment** (`supplier.manage`);
  - **Mark inactive / Reactivate** (`supplier.manage`). This is master data only: no history is removed and nothing is gated.

### Agreement page (`/agreements/:id`)

- **Builder (draft).** TQM recommends what to include:
  - the classified master agreement and SUP-03 in force;
  - every technical specification whose applicability (product family, material, manufacturing process) matches a part supplied from the covered sites;
  - the released technical baselines of those exact sources, as part-specific schedules.

  The preparer adds, removes and orders lines and sets each line's precedence, contractual reference (e.g. *Schedule B1*) and applicability (sites, parts, families). Exhibits are PDFs attached to the agreement. Each line records the document number, exact revision and SHA-256. **Preview package** renders a draft PDF marked *DRAFT PREVIEW - NOT FOR SIGNATURE*.
- **Precedence conflicts are flagged, never resolved by TQM:**
  - two revisions of one document;
  - two specifications of one category;
  - equal precedence across roles.

  Each applies only where applicability overlaps. The approver must record how each conflict is resolved.
- **Lifecycle:** Draft → Internal review → Approved (awaiting signatures) → Executed. From there an agreement can become Superseded (by a renewal) or Terminated, or show as Expired once its expiry date passes. A draft or an approved agreement can be Cancelled.
- **Submit (`supplier.manage`).** An agreement or renewal must incorporate the Master Supplier Agreement. An amendment must state what it changes.
- **Approve for execution (`supplier.qualify`).**
  - The approver must be independent of the preparer and the submitter (POL-01, audited when refused).
  - The legal review must be recorded: reviewer, reference, date.
  - Approval freezes the manifest with a SHA-256 and generates the package PDF.

  **Approval is not execution.**
- **Record execution (`supplier.manage`).** The signed PDF must be attached to the agreement. The user enters the effective date and the PDI and supplier signatories (name, title, date). TQM records this as attestation from the signed copy; it applies no electronic signature. A second package edition is generated with the execution record.
- **Amend, Renew, Terminate (`supplier.qualify`), Cancel.**
  - An amendment carries only its changes: *add*, *replace* or *remove* a document. Once executed it applies to its parent.
  - A renewal carries the documents in effect forward at the revisions now in force. When executed, it supersedes the original and its amendments.
  - Executed agreements never change. The database refuses updates and deletions.

### Package PDF

The package contains generated pages followed by the incorporated documents:

1. A cover with the scope.
2. A document index in precedence order, with each document's first page.
3. A manifest table with every SHA-256.
4. Any precedence conflicts and the recorded resolution.
5. An approval and execution page.
6. Every incorporated controlled document, appended page for page from its stored original (originals are never altered), and each part schedule rendered from its released content.

Every generated page carries the notice that TQM assembles the package but authors no contractual terms. Each edition is validated: every appended page is compared with its original (content-stream SHA-256). The result is stored with the rendition.

### Document Library

- **New kind.** Coded documents outside the Appendix B registry (e.g. `SCS-001`, `MSA-001`) import as kind *Specification / agreement document*. Revision labels may contain a dot (`Rev1.0`).
- **Classification (`documents.control`).** On the document page, **Classify for supplier agreements** sets:
  - the classification: master agreement template, supplier quality agreement or technical specification;
  - the category (configurable list: casting, forging, machining, fuel cleanliness, coating, electronics, marking, packaging; new ones via `POST /api/specification-categories`);
  - applicability rules and default precedence.

  SUP-03 is a supplier quality agreement by default.
- **Clauses.** **Record clauses** lists the clauses of an exact revision (e.g. `§6.3 Internal soundness`). They are immutable once recorded, so citations stay stable.
- **Revision impact.** Releasing a newer revision never changes an executed agreement. Instead:
  - an *agreement revision review* work item opens for each executed agreement still on an earlier revision;
  - the document page lists those agreements with suppliers, sites, parts, exact sources and acknowledgments;
  - the agreement page shows that a newer revision is in force.

  Amending is a deliberate act.

### Operational traceability (SCS-001 and every classified specification)

- **Receiving inspection.** The documents governing the part from that site on the receipt date are recorded when the inspection is launched (`specification_snapshot`) and shown on the workbench as *Applicable controlled requirements*. Pass/fail limits still come only from the released baseline. OPS-02 is unchanged.
- **First article.** The same snapshot is recorded at sample registration and shown with the sample. VAL-02 is unchanged.
- **NCR.** **Cite requirement** records the exact specification revision, the clause (checked against the recorded clauses) and the part schedule. They appear on the NCR, in the OPS-06 problem description and on every linked SCAR.
- **Technical baselines (part schedules, Annex A).** A baseline can name its governing specification revision. It can also record structured schedule content: material, process, identification, logo, additional inspection and authorized exceptions. Each characteristic can carry a clause reference such as `SCS-001 §6.3`. All of this freezes on release with the existing guard.
- **Sources and parts.** The source page shows *Contractual coverage* and the part page shows the specifications governing each exact source. Both are informational: no new approval gate, and no change to any historical approval.

### Supplier acknowledgments

The existing acknowledgment record now also covers a controlled document revision for a supplier, optionally for one site.

- An acknowledgment remains revision-specific.
- It is not proof of compliance or of execution.
- It can record supplier exceptions.
- TQM refuses to request one for a revision that an executed agreement covering that site already incorporates.

### Single approval path for SUP-03

A package that incorporates SUP-03 is that Supplier Quality Agreement's approval and execution. A separate SUP-03 controlled record is refused while such a package is open or executed. In the other direction, SUP-03 cannot be added to a package while a standalone SUP-03 record is open. Existing SUP-03 records are unchanged.

## Migration notes

`migrations/0014_supplier_agreements.sql` is additive and forward-only. No existing row is rewritten.

**Document Library**

- `controlled_document.kind` also allows `SPECIFICATION`.
- New `specification_category` table (seeded; retired, never deleted).
- New `document_classification` table (never deleted).
- New `document_clause` table (immutable).

**Parts and technical baselines**

- `company_part`: new `material` and `manufacturing_process` columns.
- `baseline_revision`: new `governing_spec_revision_id` and `schedule` (jsonb, default `{}`).
- `baseline_characteristic`: new `spec_reference`.

All are frozen on release by the existing guards.

**Supplier acknowledgments**

- `source_id` and `baseline_revision_id` become nullable.
- New columns: `supplier_id`, `site_id`, `document_revision_id`, `exceptions`.
- A check requires either the baseline subject (as before) or the document subject.
- A unique index allows one pending acknowledgment per document scope.
- The guard also freezes the new identity columns.

Existing rows satisfy the check unchanged.

**Operational records**

- `inspection.specification_snapshot` and `fai_sample.specification_snapshot` (nullable).
- `ncr.governing_revision_id`, `governing_clause`, `governing_baseline_revision_id` (nullable).

**Agreement tables (new)**

- `supplier_agreement`, with a guard that:
  - makes identity and supplier immutable;
  - freezes terms outside draft;
  - makes the approved manifest immutable;
  - allows an executed agreement to change only to superseded or terminated;
  - refuses deletion.
- `supplier_agreement_site` and `supplier_agreement_document`: change only while the agreement is a draft; a site must belong to the agreement's supplier.
- `supplier_agreement_signature`: immutable.

**Work items**

New kinds: `AGREEMENT_REVIEW`, `AGREEMENT_EXECUTION`, `AGREEMENT_REVISION_REVIEW`.

**Reused without schema change**

- `report_snapshot` / `report_rendition` / `controlled_output_validation` (subject `SUPPLIER_AGREEMENT`, job `agreement_package`);
- `evidence_link` (entity `SUPPLIER_AGREEMENT`);
- `audit_event`.

Backups count the new tables.

## Manual acceptance (PDI owner)

Use the Render test environment (fictional data). The pilot already holds Bluestone Castings' agreement history; see [construction/TEST_ENVIRONMENT.md](../construction/TEST_ENVIRONMENT.md) for sign-in. Each "→" names the persona to sign in as.

1. → Casey: **Suppliers → Bluestone Castings**.
   - The **Agreements & Specifications** section shows:
     - the current agreement (the renewal) with MSA-001 Rev S01;
     - SCS-001 Rev S1.1 and the TQ-CYH-4004 schedule under *Incorporated specifications* and *Part-specific schedules*;
     - the executed amendment;
     - the superseded original under *Historical agreements*;
     - the signed copies under *Supporting documents*;
     - the audit history.
   - Open the original: its manifest, signatures, signed copy and both package editions open.
2. Open the renewal's latest package PDF.
   - The cover, index and manifest are followed by MSA-001, SCS-001 and the part schedule.
   - Every generated page carries the TQM notice.
   - The synthetic documents say *SYNTHETIC TEST DOCUMENT* on every page.
3. → Avery: **Documents → SCS-001**. The page shows:
   - the classification (casting);
   - the clauses of Rev S1.0 and S1.1;
   - *Incorporated in agreements*;
   - *Revision impact* (empty after the amendment).
4. → Morgan: on **Northwind**, open the draft agreement.
   - **Add** the recommendations and **Save manifest**, then **Submit for review**.
   - → Casey: **Approve for execution…** with a fictional legal review.
   - → Morgan: attach any PDF as the signed copy, then **Record execution…**.
   - The supplier page now shows it as active.
5. Authority and integrity:
   - On an agreement in review, Morgan (the preparer) has no **Approve** action. Approval needs `supplier.qualify` and a person independent of the preparer and the submitter (POL-01).
   - → Jordan sees agreements read-only, with no lifecycle actions.
   - Executed agreements offer no edit actions to anyone, only **Amend**, **Renew** and **Terminate**.
6. → Avery: on SCS-001, **Add revision** (any PDF named `SCS-001_…_RevS1.2.pdf`).
   - Bluestone's renewal shows *Rev S1.2 is now in force*, and an *agreement revision review* appears in Casey's My Work.
   - The executed agreement is unchanged.
7. → Jordan: launch a receiving inspection of TQ-CYH-4004 from Bluestone FA. The workbench shows *Applicable controlled requirements* (SCS-001, the part schedule), while limits still come from the baseline.
8. → Casey: on an NCR for that part, **Cite requirement**: SCS-001, clause §6.3 and the part schedule. The citation shows on the NCR and on a SCAR linked to it.
9. → Riley: suspend Bluestone. → Morgan: **Mark inactive**. The agreements, documents and history all remain on the supplier record.

## Decisions that remain with PDI

These are also listed in the architecture note.

- **Master Supplier Agreement.** The legal text, the precedence wording and the amendment procedure come from PDI counsel. `MSA-001` in the pilot is a synthetic outline.
- **SCS-001 Rev 1.0.** Import the approved file. In the test environment it imports as an ordinary new revision on top of the synthetic `S` revisions and opens revision reviews on the pilot agreements.
- **Casting acceptance criteria** (porosity classes, sampling, tolerances). These come only from PDI-approved engineering documents and become baseline characteristics when Engineering releases them.
- **Source-approval gate.** Whether an executed agreement should ever become a source-approval gate. Today coverage is shown only.
- **Legal electronic signatures.** Not implemented. Execution is recorded from the signed copy.
