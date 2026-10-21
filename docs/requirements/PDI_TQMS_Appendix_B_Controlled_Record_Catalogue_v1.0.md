# PDI TQMS — Appendix B: Controlled Record and Document Type Catalogue
**17 October 2026 | Clean-sheet business-content specification | Companion to TQMS functional specification v1.0**

## B1. Required business behavior
A catalogued **document type** is not automatically a mandatory file or screen. The product must support structured in-app records, uploads, and generated professional PDFs under one revision-controlled identity, with applicability determined by product risk, sourcing pathway, contractual requirements, and PDI policy. A checklist can reference evidence already present; avoid re-entering facts in duplicate forms. Where there is no published blank template, do not invent a PDI-authorized format. Propose a useful structure for PDI approval. Only authorized released revisions may satisfy required evidence gates; waivers need reason and authority. Supplier sharing must not expose internal notes.

## B2. Candidate controlled record types
Codes and business titles below identify requirements families; they do not prescribe one database table, screen or approval workflow per entry. This list is a catalogue of **supported record types**, not an instruction to require all of them for every transaction.

| Business code | Record or evidence family | Typical applicability |
|---|---|---|
| INT-01 | Product Sourcing Request (PSR) | Sourcing initiation; routine internal capture |
| INT-02 | Sourcing Path & Risk Assessment (SPRA) | Sourcing initiation; routine internal capture |
| SUP-01 | Supplier Qualification Questionnaire (SQQ) | Supplier/site evaluation or contractual need |
| SUP-02 | Supplier Capability / Process Assessment (SCA) | Supplier/site evaluation or contractual need |
| SUP-03 | Supplier Quality Agreement (SQA) | Supplier/site evaluation or contractual need |
| SUP-04 | Non-Disclosure Agreement (NDA) | Supplier/site evaluation or contractual need |
| SUP-05 | Sub-tier / Critical Process Disclosure | Supplier/site evaluation or contractual need |
| ENG-01 | Customer-Controlled Drawing / TDP Checklist (TDP) | Product engineering and technical baseline |
| ENG-02 | Design Review & Engineering Release (DRR) | Product engineering and technical baseline |
| ENG-03 | Physical Sample / Reverse Engineering Intake (REI) | Product engineering and technical baseline |
| ENG-04 | Supplier Baseline Product Specification (SBPS) | Product engineering and technical baseline |
| ENG-05 | Supplier Part Cross-Reference & Configuration Record (SPCR) | Product engineering and technical baseline |
| ENG-06 | Customer-Specific Requirements / Delta Specification | Product engineering and technical baseline |
| ENG-07 | Altered / Selected Item Drawing (AID / SID) | Product engineering and technical baseline |
| ENG-08 | Critical Characteristics & Acceptance Matrix (CCM) | Product engineering and technical baseline |
| ENG-09 | Specification / Revision Change Record (ECR / ECN) | Product engineering and technical baseline |
| VAL-01 | Product Qualification & Validation Plan (PQP) | Validation, qualification and PPAP when applicable |
| VAL-02 | First Article Inspection Report (FAI / FAIR) | Validation, qualification and PPAP when applicable |
| VAL-03 | Functional / Performance Test Report (PTR) | Validation, qualification and PPAP when applicable |
| VAL-04 | Material / Coating / Special Process Certificate Checklist | Validation, qualification and PPAP when applicable |
| VAL-05 | PPAP Applicability & Submission Requirements | Validation, qualification and PPAP when applicable |
| VAL-06 | Part Submission Warrant (PSW) | Validation, qualification and PPAP when applicable |
| VAL-07 | Process Failure Mode and Effects Analysis (PFMEA) | Validation, qualification and PPAP when applicable |
| VAL-08 | Production Control Plan (CP) | Validation, qualification and PPAP when applicable |
| VAL-09 | Measurement System Analysis (MSA / GRR) | Validation, qualification and PPAP when applicable |
| VAL-10 | Process Capability / SPC Study | Validation, qualification and PPAP when applicable |
| VAL-11 | Product & Supplier Approval Record (PSAR) | Validation, qualification and PPAP when applicable |
| OPS-01 | Incoming Inspection Plan (IIP) | Receiving, quality disposition, change and operational evidence |
| OPS-02 | Incoming Inspection Report (IIR) | Receiving, quality disposition, change and operational evidence |
| OPS-03 | Supplier Product / Process Change Request (SCR / PCN) | Receiving, quality disposition, change and operational evidence |
| OPS-04 | Change Impact & Requalification Decision (CIRD) | Receiving, quality disposition, change and operational evidence |
| OPS-05 | Temporary Deviation / Concession Request (DCR) | Receiving, quality disposition, change and operational evidence |
| OPS-06 | Nonconformance Report (NCR) | Receiving, quality disposition, change and operational evidence |
| OPS-07 | Supplier Corrective Action Request (SCAR) | Receiving, quality disposition, change and operational evidence |
| OPS-08 | Structured Problem-Solving Report (8D) | Receiving, quality disposition, change and operational evidence |
| OPS-09 | Supplier Performance Scorecard (SPS) | Receiving, quality disposition, change and operational evidence |
| SYS-01 | Document Type / Retention & Approval Rules (DRM) | Administrative control/policy |

## B3. Required links and output behavior
Sourcing-related intake records must link to the specific project and product source. Supplier records identify the supplying legal entity and manufacturing site. Engineering baselines identify the part, source where appropriate, exact revision, characteristics, supplier acknowledgments and effective issue. Validation documents identify sample type and serialized/lot origin; FAI, test records and actual shipment inspections cannot be substituted for one another. Product & Supplier Approval Record identifies precise supplier/site/part/configuration/revision and frozen authorized evidence. Incoming Inspection Reports derive from the inspection record, with readings and photographs. Deviation, NCR, SCAR and change records preserve independent resolution status and cross-links. Retention and authority must be configurable and approved by PDI.

## B4. Applicability examples, not universal mandates
- Buying a low-risk supplier-standard item may need authoritative supplier specifications, traceable supplier approval and basic acceptance evidence, but not a full PPAP package.
- Manufacturing a company-controlled critical part may require drawing/revision release, engineering review, special-characteristic matrix, FAI, functional testing and special-process certification.
- A supplier-specific coating modification requires an accepted delta specification, documented supplier acknowledgment, measurable incoming verification and a product/source approval decision.
- A significant product or manufacturing-site change may trigger requalification or new FAI; a minor administrative change should not.

## B5. Business policy still to be confirmed
Final preparer/reviewer/approver authority by type and risk; exact customer/industry PPAP applicability; official blank form versions and branding; preservation/retention schedule; supplier-release permissions; independent review requirements; how conditional document evidence satisfies an approval gate. Architecture must support these decisions without embedding arbitrary hard-coded assumptions.
