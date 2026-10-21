# PDI Total Quality Management System (TQMS)
## Clean-Sheet Functional and Operational Requirements Specification — v1.0
**Issued:** 17 October 2026  
**Audience:** Independent solution architect and engineering team  
**Purpose:** Define required business outcomes, user interactions, records, controls, quality gates, and acceptance tests. Technical architecture is intentionally open.

## 1. Mandate and operating context
PDI distributes and develops heavy-duty diesel-engine components, including precision and safety/reliability-relevant products. Design one coherent, secure browser-based work system covering product definitions, sourcing, supplier evaluation, product/source qualification, receiving inspection, specialized injector testing and repair history, nonconformances, changes, controlled records, and management follow-up. The application is called **TQMS**.

PDI has approximately seven internal users at initial launch, with overlapping duties: executive management, engineering, sourcing/purchasing, receiving/inspection, and quality. The system must work without dedicated full-time personnel for each process; it must scale to more people, manufacturing sites, and external suppliers. The core product is a **system for conducting and controlling work**, not merely file storage or a PDF form library.

**Non-negotiable outcomes:**
1. A user can accomplish routine work with minimal repetitive entry and without understanding the entire quality framework.
2. Important work has an owner, observable status, evidence, and closure; significant decisions are attributable.
3. An approved technical requirement, supplier/site qualification, product-source approval, and shipment-specific disposition are distinct business concepts.
4. Critical decisions cannot silently bypass documented technical requirements, unresolved blockers, or approvals.
5. Inspection work must follow the detailed interaction contract in §6 and Appendix A; specialists must be able to work rapidly, including multiple serialized items, measurements, and images.
6. The system must preserve historical truth when specifications, forms, approvals, source conditions, or personnel change.
7. Governance is proportionate to product risk and impact. Design support for future ISO 9001 certification, without claiming that software alone confers compliance or imposing comprehensive certification procedures from day one.

**Design latitude:** Choose the implementation architecture, persistence model, UI technology, hosting, background jobs, integration mechanisms, service boundaries, and deployment method on their merits. A business workflow or UI interaction specified below is a functional constraint, *not* a direction to implement a particular software architecture.

## 2. Scope and priority convention
- **P0 — Initial operational release:** Required to operate the complete, end-to-end daily business workflows. A release with empty screens or placeholder functionality does not satisfy P0.
- **P1 — Near-term / risk-triggered:** Available where specified risk, customer, or management requirements activate it. Not every transaction must use every feature.
- **P2 — Designed for later activation:** Future capabilities need credible expansion points, not necessarily completed interfaces at launch.
- **POLICY OPEN:** Business choice requiring PDI confirmation before a high-impact release gate is relied upon. The solution architect may recommend a conservative default and must call out the decision; it must not silently invent PDI authority or numerical thresholds.

**Operational maturity:** Everyday recordkeeping, responsibility, dispositions, issued specifications, and evidence controls are P0. Selective higher-level validations/approvals are P0/P1 based on risk. Formal audit programs, periodic management reviews, and companywide competency administration are P2. All records must be natively traceable from the first operational release.

## 3. Shared business records and relationships (P0)
**FR-001** Users, roles, authorizations, and assignments: every consequential action records person and timestamp. A person may perform multiple functions; authorization is action- and record-scoped, not limited to one job title. Separate read, create, amend, release, disposition, approval, administrative, and sensitive-data privileges.

**FR-002** Supplier organization: legal/trading names, identifier, supplier category/capabilities, status, contacts, notes, relevant agreements/certificates, and qualification history. Multiple manufacturing sites belong to one supplier; site identity/status is independent of parent status.

**FR-003** Product/source identity: company part number and aliases/OE cross-references; supplier part number; supplier manufacturing site; product family/criticality; design ownership; configuration; drawing/specification revision; material/process/coating; applicable approval and its conditions. One company part may have multiple authorized source combinations; identical part numbers do not imply equivalent sources.

**FR-004** Authorized engineering baseline: revision-specific technical requirements, accepted characteristics/limits, special characteristics, drawings, specifications, visual acceptance criteria, inspection/test methods, and controlled effective/applicability information. Drafts, under-review records, and released records must be visibly distinct.

**FR-005** Sourcing/qualification: intake/request, commercial rationale, owner and dates, sourcing pathway, risk assessment, required evidence, tests and first articles, decision history, final authorized product-source approval package.

**FR-006** Receiving/manufacturing quality context: PO or purchasing reference, supplier/site, company/supplier part, received date, shipment/lot/batch, inspected quantity, sampled units, serial numbers when present, applicable revision/approval, inspector, test results, images, final outcomes and nonconformances.

**FR-007** Quality action network: informal observation, quality alert, nonconformance report (NCR), containment, deviation/concession, supplier corrective action request (SCAR), root-cause/effectiveness evidence, source change, engineering change, actions, deadlines, notices and supplier commitments. Creating a formal record from an observation must preserve evidence and relationships without duplicate re-entry.

**FR-008** Document/evidence identity: document type and number, revision, owner, source record(s), approver/reviewer, lifecycle, issue/effective date, applicability, attachment versions, disposition, retention classification, and immutable historical references. Link a document to several business records rather than create disconnected copies.

**FR-009** Record chronology: support a readable history combining comments, task assignment, supplier communication, approvals/rejections, version changes, attachments and status transitions. Preserve evidence of the supplier's stated position separately from PDI's authorization.

**FR-010** Search/traceability: from a company part, supplier, manufacturing site, supplier part, PO/lot, serial, inspection, NCR, approval, or revision, navigate to related history with permission-filtered results. The system must be able to answer, “What requirements and supplier/source approval applied to this lot on this date?”

## 4. Unified everyday work, communications, and follow-through (P0)
**FR-011** Each user has a clear work queue of inspections, requests, tasks, reviews, due dates and overdue items relevant to them; managers can view unassigned and overdue work across the company without managing duplicate task lists.

**FR-012** Quick capture of an issue, supplier discussion, promise, concern, meeting decision, drawing question, or follow-up from an appropriate record. Capture topic, brief description, originator, date and relevant supplier/part/PO when known; let users supply additional detail after the immediate capture. Do not demand a formal NCR for every note.

**FR-013** Each actionable commitment has a named accountable owner, target date or explicit no-date reason, status, activity, supporting evidence, and completion/closure outcome. Escalation/reminders are proportional to severity; dismissal is recorded and must not erase the underlying duty.

**FR-014** Supplier commitments have a representative/communication source, promised action, expected outcome, target date, linkage to affected product and revision, response/acknowledgment where pertinent, and verification that the delivered result matches the agreement. Email attachments and photographs may be logged as evidence; a supplier's claim is not proof of execution.

**FR-015** When an observation becomes a confirmed nonconformance, the system prompts for the authorized disposition and required containment. Formal escalation must add governance without losing the quick-capture record.

**FR-016** Contextual work pages display related open issues, actions, released requirements and relevant source history; users should not manually gather information from separate registers to make an ordinary decision.

## 5. Supplier, sourcing, engineering, and product qualification (P0 unless marked)
### 5.1 Supplier/site qualification
**FR-020** Register prospective suppliers and sites; capture contacts, manufacturing capabilities, product families, certificates and expiration, qualifications, restrictions and reasoned status transitions. Prevent creating an approved status through an unreviewed field edit.

**FR-021** A supplier qualification or periodic reassessment specifies subject (supplier or named site), scope, assessment findings, evidence, proposed result (approved/conditionally approved/rejected), conditions and authorized decision. Site qualification must not implicitly qualify other sites. If conditional, state conditions and validity.

**FR-022** Suspension, expiry or disqualification must generate visible warnings, defined action on new and existing product-source approval eligibility, and appropriate management review. **POLICY OPEN:** precise propagation effect on already-approved products and purchase/receipt authorizations. Conservatively, make affected activity visibly blocked pending authorized review rather than silently presenting approvals as unrestricted.

**FR-023 [P1]** Supplier evaluation, certifications, reviews, and performance trends have reminder/renewal rules; calculate delivery and quality performance from source records where data exists. Distinguish unknown evidence from a good score.

### 5.2 Three sourcing scenarios
**FR-024** Guided sourcing intake supports three alternatives with common product/source data but different conditional evidence needs:
- **A — Company-defined technical design:** Supplier will make a part to PDI-defined technical requirements, including a branch for reverse engineering a supplied sample and releasing a verified technical baseline before purchase authorization.
- **B — Supplier-standard product:** PDI will purchase the supplier's established standard item. Capture supplier's authoritative specification, guaranteed characteristics, acceptance plan, and applicable cross-reference.
- **C — Modified supplier product:** A supplier-standard item becomes a PDI-specific configuration. Identify the base product and exact delta requirements, acceptance/verification criteria and supplier acknowledgment; do not silently collapse these into the standard product record.

**FR-025** The intake identifies product, design ownership, supplier/site, risk considerations, quantity/application, initial technical baseline, owner and target date, required validation and requested documentation. Permissible to save incomplete drafts and resume. Avoid forcing a lengthy all-in-one wizard before recording a request.

**FR-026** A repeatable risk method considers engine/reliability criticality, failure severity, process and supplier maturity, newness, manufacturing changes, verification difficulty and known quality history. Risk determines the applicability and level of validation/documentation/approval. Preserve the assessed inputs, rules/version, result and subsequent reassessments. **POLICY OPEN:** risk weights, override authority and required thresholds.

**FR-027** Applicability requirements are visible as plain-language work items: required, conditional, not applicable, satisfied, under review, or specifically waived. Every waiver has reason, authorized decision, applicability and date. A policy change must not silently erase already-approved evidence or outstanding requirements.

### 5.3 Technical definition and controlled release
**FR-028** Engineering records include relevant drawings, tolerances, finish, coating, material/heat treatment, dimensions, functional performance, critical-to-quality characteristics, inspection method/frequency and accepted limits. Support numerical limits and nonnumeric/visual criteria; allow uploaded vendor specifications where PDI does not own the design.

**FR-029** Draft changes are easy to make and discuss. Only authorized released versions may serve as controlling supplier, inspection or product qualification requirements. Preserve effective dates and distinguish proposed from authorized changes; a newer draft must not replace the applicable released baseline.

**FR-030** Supplier acknowledgment of company-specific requirements records what exact revision was sent, how, to whom, response/date, any objections, and evidence. A signature or acknowledgment does not itself verify a process was executed or a product conforms.

**FR-031** Engineering revision changes can trigger reassessment of test/inspection criteria, affected source approvals, WIP/stock and supplier acknowledgment; existing test results remain attached to original limits/revisions.

### 5.4 First article, validation, and release
**FR-032** A qualification references **one exact company part + supplier + manufacturing site + supplier part/configuration + revision** and explicit conditions. Qualifying a supplier alone does not authorize a new part or site.

**FR-033** Register individual evaluation samples and distinguish initial FAI, replacement/re-submitted FAI, engineering prototype, production-representative sample and subsequent production lot. Track source, serial/lot, revision, inspection/test outcomes, deviations, identified defects, and associated supplier corrective evidence.

**FR-034** Rejection of an initial first article cannot be erased by acceptance of a replacement. Where the failure suggests process instability, require documented consideration of root cause, process correction, process representativeness and production follow-up, with decision/evidence proportional to risk. A passing sample does not by itself prove process capability.

**FR-035** Define validation plan per source/criticality; capture test procedure/version, test conditions, measured values, result and independent review where required. Support pending/conditional/pass/fail with explicit accepted exceptions. Do not treat conditional evidence as unqualified pass.

**FR-036** Product authorization must evaluate at decision time: released definition, supplier/site eligibility, verified delta requirements, required documents, tests/FAI, unresolved blocking NCRs/deviations, authority and restrictions. Show each missing or failing gate with an actionable link; re-check on final approval, not just initial submission.

**FR-037** On approval, create a durable immutable snapshot or equivalent tamper-evident record of the authorized revision, supplier/site/source, applicable evidence and decisions, conditions, approvers, and effective authorization. Later changes/suspensions cannot retroactively edit the historic approval.

**FR-038 [P1]** Compile professional PPAP-related evidence proportionately to customer/product needs: FAI, inspection/control plan, risk assessments, material/special-process certificates, measurement-system study, capability evidence, submission warrant and response. Do not impose full PPAP on every routine purchase.

## 6. Receiving inspection — detailed required user interaction (P0)
This section is **an interaction contract**, not merely a capability list. The screens, sequence, terminology and low-friction actions matter. A receiving inspector must perform ordinary work without navigating supplier qualification or engineering management interfaces. Product identity and released specifications should appear automatically when available.

### 6.1 Starting an inspection
**FR-040** Provide prominent **New Inspection**, **Inspections**, and **My Inspections** actions. Search/filter inspection history by company part, PO, lot/serial, component family, inspector, date, status and outcome. An assigned-inspections queue shows due dates; permitted managers can assign/reassign work and reason/date.

**FR-041** New Inspection is a compact single-screen form or modal with fields in familiar operational order: Part Number (type-ahead and product description), Part Type / Inspection Form (auto-suggest from part), Number of Items (1–100), PO Number, Date Received, Inspector (defaults to signed-in user). The workflow must additionally record or auto-derive Supplier, Manufacturing Site, Lot/Shipment, Lot Size, Sample Size and Sampling/AQL plan when relevant; these may be contextual optional fields to avoid delaying ordinary inspections. Starting an inspection opens its entry view immediately.

**FR-042** Permit authorized creation/editing of reusable inspection templates and a **Miscellaneous / One-off Inspection** builder with receiving, visual and dimensional sections. A user can inspect a product not yet in the formal template catalog without disabling control of normal released forms. Template numbering and revision are visible. Controlled edits apply only to newly initiated inspections, not to completed historical ones.

### 6.2 Inspection entry screen
**FR-043** Keep a **persistent/sticky header** with form number and revision, component/part, PO, inspector, received date, item/serial context, current status and an unambiguous saved/unsaved indicator. Actions include Save, Save as Partially Complete, Complete Inspection, PDF/Print, optional Share/Email, and Close. Support automatic saving of ordinary edits without losing control of final submission.

**FR-044** Show **Section A — Receiving and Documentation** only once for the entire inspection, not separately for each serial number. It records carton/packaging, identification, quantity/PO and paperwork checks appropriate to the form. Response values are **P (Pass), F (Fail), A (Accepted), N (N/A)** where N/A is applicable. If a question is set to Fail or Accepted, demand observation/description and at least one directly associated image before completion. Distinguish skipped/unanswered from deliberate N/A.

**FR-045** Show a clearly labeled tab per inspected unit, e.g. **Item 1**, **Item 2** or the unit's serial. Provide **Previous / Next** controls without leaving the inspection; the unit may carry its own serial number, results, comments, measurements, photographs and final disposition. Section A answers must remain shared. Item navigation must not discard partially entered values.

**FR-046** Each unit includes a **Visual Checklist** of characteristic, acceptance criterion, result, notes/observation and inline camera/image attachment per row. Response choices **P/F/A** must be rapidly selectable, visually evident, and reversible while editable. Provide **Pass All** for visual checks with confirmation before overwriting entered answers. Do not automatically mark incomplete measurement sections passed when Pass All is used.

**FR-047** A checklist Fail or Accepted answer requires a description and image tied to the **specific characteristic**; show missing-evidence feedback beside the row, and prevent final completion until resolved. Image add/remove/preview must work on phones/tablets and desktop; offer per-row capture plus a general/bulk inspection gallery with captions. Photos must retain reliable linkage to item, question and record version.

**FR-048** Support applicable numeric/dimensional sections (optional or preconfigured per component). Present characteristic, location, controlling spec/limit, Actual 1/2/3 as appropriate, result, optional notes and image. Measurements should be preserved as entered, with units, method and provenance as available. When reliable structured limits exist, calculate suggested pass/fail and flag out-of-tolerance values; **never silently turn a failing measurement into a pass**. An authorized disposition may accept nonconforming material with recorded reason and scope.

**FR-049** Support the component-specific specialized measurement patterns in Appendix A: single-reading table, multi-reading table, seven camshaft-bore readings, six-cylinder fire-ring protrusion, six-cylinder groove specifications, six-cylinder valve recession with intake/exhaust values and limits, and a six-cylinder vacuum test with failing-cylinder valve subresults. Optional measurement sections appear on user action such as **Add Dimensional Inspection**, without concealing required sections.

**FR-050** Each inspected unit has a final **PASS / FAIL / ACCEPTED** disposition. The overall inspection result derives from worst outcome across all units (FAIL outranks ACCEPTED, which outranks PASS). An Accepted result represents a controlled acceptance decision for a nonconforming condition, *not* a normal pass. **POLICY OPEN:** exact authority, timing and signoff for accepted items, status of partially completed records, and whether a review is required before stock release. Favor an explicit review state when a concession is needed.

**FR-051** Permit **Save as Partially Complete** with clearly visible pending items and next action. Completion must validate all required responses, evidence and dispositions and identify exactly which questions or units remain unresolved. Prevent accidental navigation/data loss. An authorized correction or reopening of a completed record must retain the original values and history with who/why/when.

**FR-052** After completion, provide a readable inspection summary with the common receiving results, each item's sections/readings/images and disposition, derived overall outcome, inspector and timestamps. The inspector can retrieve, print, download and share the finalized inspection report using familiar one-step actions. Reports must not drop a relevant failure, comment, measurement or photo.

**FR-053** Generate a branded PDF that is legible and coherent for an inspection with multiple units and many images, preserving the correct form and spec revisions. Provide data export for authorized analysis. N/A fields can be omitted from a concise customer-facing report if intentional and defined; original responses must remain in the searchable history.

**FR-054** Create or propose a linked quality finding directly from an out-of-spec result or FAIL/ACCEPTED disposition, carrying supplier/part/PO/lot/serial, characteristic, expected/actual and photos into the quality record. Do not require the inspector to fill out a full supplier corrective action during inspection. Quality alerts must route to an owner and track acknowledgment/resolution; merely acknowledging an alert does not dispose of the material.

**FR-055** A controlled inspection form is selected by component/product and revision. Finished inspections reference a frozen copy/version of form questions and applicable limits; changing a template, engineering drawing or specification cannot retroactively change a completed inspection's questions, calculated conclusion or generated historical report.

**FR-056** Inspection lists and dashboards reflect consistent status counts (open, partially complete, pending review, finalized), queue age, assigned inspector and outcome. Filter results must match displayed counts; role restrictions protect data and write actions at the server boundary.

### 6.3 Inspector usability and performance tests
**FR-057** In an acceptance walkthrough, an ordinary inspector must: start an inspection from a known part; enter one receiving section; complete two serialized units (one Pass and one Fail); attach one row-specific photo; save/resume; receive precise missing-evidence feedback; complete the authorized workflow; and create/download the correct report. No specialized sourcing/engineering screens or duplicate record entry are required.

**FR-058** A separate walkthrough must cover an Accepted result; an administrator edits a future template revision; a historic inspection retains its original form/measurements; and an authorized user corrects a completed record with preserved history. Product-family specialist walkthroughs must use Appendix A's section types and terminology.

## 7. Precision injector test, adjustment, repair and reports (P0)
**FR-060** Support ingested and manually entered fuel-injector bench tests, including CarbonZapp-compatible test datasets subject to equipment interface definition. Ingestion must be idempotent and report what was added, updated or excluded; keep raw source identity, timestamp, machine/source, serial, part and test conditions. Prevent bulk synchronization or pruning from silently destroying authorized records.

**FR-061** Allow quick search/filter by injector part/serial, test date, tested condition, pass/fail and diagnostic values. View all sequences of tests for a single serialized injector. Support selecting one or several injectors for a comparison/shipment evaluation in user-controlled order.

**FR-062** Log repair case history with opened/closed status, defect/problem, component changed, action, settings/measurements, technician, notes and retest. Provide quick-entry values for repeated workshop adjustments without navigating many fields. Retests must link to the correct repair action and serial.

**FR-063** Produce injector comparison PDF/spreadsheet, shipment evaluation report, injector inspection report and summary analytics for first-pass yield, repair effectiveness, adjustment patterns and test volume. Clearly distinguish original, repaired and retested states and data source.

**FR-064** Restrict technical test exports and any scheduled external reporting to authorized operators; allow configurable destinations and error visibility. **POLICY OPEN:** equipment protocol, exact data fields, exclusions, retest grouping and downstream destinations; these must be verified with bench samples before production use.

## 8. Nonconformance, concession, corrective action, and containment (P0)
**FR-070** A finding can originate from inspection, tests, FAI, manufacturing, shipment/customer complaint, supplier communication or ad hoc capture. Triage classifies observation vs confirmed NCR, severity, affected scope, responsible person and risk; links to the correct source/revision and earlier similar occurrences.

**FR-071** NCR records support factual defect description with expected-vs-actual results, affected supplier/site/product, lot/serial/quantity, images, source, cause/containment notes, and status. Nonconforming material is not automatically usable merely because a record exists.

**FR-072** Require an authorized material disposition before closing a confirmed NCR. Supported outcomes include rework, repair, return, scrap, and use-as-is subject to an authorized concession. Provide containment and subsequent acceptance/verification evidence. Preserve rejected/changed decisions and who approved them.

**FR-073** A concession/deviation is scoped to exact product/configuration, source and affected shipment/lot/quantity, permitted exception, conditions, approving authority and validity/expiry. It cannot silently become an indefinite specification revision; exhausted, expired or unrelated concessions do not authorize later material.

**FR-074** Trigger proportionate SCAR when recurrence, severity, criticality or management requires it; record supplier's containment, root cause, permanent corrective action, implementation evidence and effectiveness verification. A supplier-submitted 8D-style response is a supported structured format, not automatically mandatory for every minor concern.

**FR-075** NCR closure, SCAR closure and qualification blockers have explicit independent conditions. **POLICY OPEN:** whether NCR may close with open SCAR (recommended: allow documented local material resolution while keeping SCAR independently open and clearly visible); which NCR statuses block approval and when a disposition clears the blocker.

**FR-076** Quality alerts and acceptance concessions must appear wherever a downstream user could unintentionally approve, receive or release affected product. Alert acknowledgment is not equivalent to verifying corrective action.

## 9. Engineering and supplier change management (P0)
**FR-080** Changes may originate inside PDI or from suppliers; cover design, critical dimension, material, coating/heat treatment, process, equipment, sub-tier, factory/site, tooling and test method. Record proposed vs authorized baseline, rationale, proposed date, lot/stock effect and supporting evidence.

**FR-081** Perform impact/risk assessment across product specs, released drawings, approval/validation, supplier acknowledgement, receiving plans, in-process stock, unaffected inventory and current shipments. Identify requalification steps as explicit tasks and prevent approval where a nonwaivable gate fails.

**FR-082** Releasing a change and verifying implementation are different events. The system records approval, the supplier's acknowledgment, proof the change was actually implemented and the first conforming delivery. Supplier statement alone cannot close verification when objective evidence is required.

**FR-083** Revised requirements retain effective date and applicability, prior revision, release decision and superseded history; old lot evidence remains traceable to old requirements. Show the two versions side-by-side or with an accessible difference summary when reviewing a change.

**FR-084** Where shipment permission depends on change qualification, a status cannot advance by changing a label alone. Support authorized bounded exceptions, captured decision, expiry, and affected quantities/lots.

## 10. Controlled documents, native records and external evidence (P0)
**FR-090** Support an administrative catalog of document **types**, not a mandated screen per type. At minimum support business record families defined in Appendix B for intake, supplier qualification, engineering, validation, operating quality, and governance. Document applicability depends on pathway, risk and contractual need.

**FR-091** Control draft, in review, approved/released, superseded and obsolete statuses; support revisions, effective dates, authorized approval, related subject, retention and safe download/preview. Template editions and a completed document's data must remain separately versioned.

**FR-092** Users can fill essential structured records directly in the interface, attach files and images, and generate professional PDI-branded PDFs without maintaining unrelated manual Word/PDF copies. Some technical submissions are legitimately third-party files; preserve those as evidentiary originals.

**FR-093** Display the correct checklist of required, conditional and waived evidence for a source qualification or change, with reason, owner, deadline, link and outcome. Do not demand every possible document for every product.

**FR-094** Supplier acknowledgments include exact released document revision, recipient, acknowledgement date, response and evidence. A shared file's release does not imply a supplier has read it.

**FR-095** Retention, immutable history, archival, export and legal/contractual requirements must be configurable; don't physically delete a decision chain as a shortcut to correction. **POLICY OPEN:** authoritative retention schedule for each record family.

## 11. Dashboard, analytics, and information retrieval (P0/P1)
**FR-100** A landing view presents “My Work”, pending inspection/review/approval actions, supplier commitments, overdue items, open quality risks and recently affected records. Prioritize action over decorative KPI cards; adapt content to the user's authorized work.

**FR-101** Search across product, supplier/site, supplier part, PO, lot/serial, source approval, inspection, test, NCR, SCAR, change, document and comment with relationship links and permission filtering.

**FR-102** Report inspection throughput/outcomes, defect types, supplier/part quality, qualification and change status, open/overdue corrective actions, certification expiration, approval history and injector test/repair performance. Results must drill into verifiable source data; report calculation definitions and date boundaries must be consistent.

**FR-103** Provide useful PDF/spreadsheet/CSV export where warranted; generated material should include document identity/revision, timestamp, source and filters when it represents an auditable decision.

**FR-104 [P1]** Highlight recurrence by part, supplier, characteristic and failure mode, especially when a production lot repeats a previously rejected FAI defect; trace through original rejected sample, accepted replacement, release decision and later nonconforming shipment.

## 12. Identity, security, governance and reliability (P0)
**FR-110** Secure local accounts and user administration are available at initial launch; ability to integrate organization-managed SSO is desirable but not a blocking prerequisite. Support invitations, password reset, user deactivation, session termination, least-privilege administration, and controlled change to access. External supplier access is **P2**, disabled until specifically designed and authorized.

**FR-111** All write/read authorizations are enforced at the service/API layer, not only by hiding a menu item. Separate authorization to conduct an inspection from authorization to release specifications, grant dispositions, approve product/source and change policy. Segregation of duties is configurable with robust controls for the small team; record any permitted authorized exception.

**FR-112** Every approval, amendment, rejection, waiver, release, correction and privileged override is recorded with actor, timestamp, prior/new state, rationale, scope and evidence. Audit history is append-only or equivalently tamper-evident to business users. Retain relevant superseded versions instead of destructive overwrites.

**FR-113** Make document/image upload reliable on phones and desktop: preview, captions, size safety, access control, scanning/validation appropriate to selected architecture, durable links and restoration from backup. Preserve a distinction between internal-only supplier commentary and approved external-facing evidence.

**FR-114** Provide monitored background processing for notifications, scheduled checks, reports and permitted equipment data imports; surfaced errors must be actionable rather than silently dropping events. Search and ordinary screen load must remain practical with years of inspection images.

**FR-115** Prepare verifiable backups and restoration tests, meaningful application logs, status monitoring, separated test/production environments and a procedure for validating software changes without corrupting production-quality evidence.

**FR-116** Management can configure practical policies and thresholds via secure administrative experience as requirements mature; ordinary users must not edit policy logic or published form definitions by manipulating client requests.

## 13. ISO 9001-oriented progression (no claim of certification)
- **P0:** authorized procedures/forms, defined responsibilities, traceable inspection/test results, supplier/source and technical controls, nonconforming outputs and dispositions, corrective-action evidence, approved revisions, useful operational metrics.
- **P1:** risk-triggered external approval packages, periodic supplier reviews, escalation and scheduled effectiveness checks, richer management reporting, objective evidence of implementation.
- **P2:** internal audit scheduling/findings, management review input/decisions, quality objectives and trends, formal competency/training records, systematic management-system effectiveness reviews and direct supplier collaboration. Design shared actors, records and evidence to support these without fundamental restructuring.

The target is to **establish good operating practices progressively**, so increasing rigor adds discrete authorizations or evidence requirements rather than requiring unrelated new processes. Compliance to any external standard requires a separate gap assessment, implemented management practices and independent certification.

## 14. Mandatory end-to-end acceptance cases
Each scenario must be demonstrable using realistic synthetic records, and failing gates must identify what must be corrected. Provide traceable tests at service and UI/workflow levels for each P0 case.

**AT-01 Receiving / multi-item:** Inspector searches a company part, launches its inspection form, answers shared receiving section, completes two serialized items, uses Pass All on passing visual rows, records a failed item with image and note, enters measured values, pauses/resumes and completes. Report includes all required details. Overall outcome FAIL; missing photo prevents completion with precise message.

**AT-02 Accepted item:** Record a nonconforming but accepted characteristic, add required evidence, route authorized concession/review as policy requires, then complete. A user without disposition authority cannot grant acceptance; acceptance remains distinguished from PASS in output.

**AT-03 Template and specification history:** Release revision B after revision A has inspections. Old records/reports remain based on A while newly started work uses B. Attempted unauthorized edit to completed evidence is rejected; a correction retains audit history.

**AT-04 Component special measurement:** Six-cylinder head inspection includes groove, valve-recession and vacuum sections, conditional failed-cylinder subresults and image linkage; a piston ring inspection captures end gap and compares to controlling limits when structured limits are available.

**AT-05 Injector:** Import tests for a serialized injector, show chronological raw/processed results, enter a repair action and quick measurement, associate retest, compare original vs repaired result, produce shipment evaluation and analyze yield without duplicate import.

**AT-06 Informal concern to formal quality action:** Log a quick piston-ring concern, assign engineer, escalate to NCR, record lot/PO/expected vs actual/photos, decide disposition, contact supplier, assign follow-up and close only after defined conditions. No retyping of source evidence.

**AT-07 Supplier coating:** Issue/record a released coating requirement, send to supplier, record acknowledgment and promise, verify coating on incoming lot. Supplier claims implementation, but incoming units are uncoated; mark failure, block affected authorization as policy requires, preserve supplier commitment and ownership until resolved.

**AT-08 FAI recurrence:** Reject first sample, accept a second with documented corrective rationale, authorize the exact part/supplier/site/configuration and condition; later production lot exhibits the original defect. From later NCR retrieve both FAIs, tests, disposition, release evidence and follow-up for recurrence.

**AT-09 Sourcing A:** Start a new company-designed or reverse-engineered component, release drawing/spec, qualify supplier/site, capture tests and FAI, approve only when evidence gates pass. A preliminary reverse-engineered draft must not masquerade as released technical definition.

**AT-10 Sourcing B:** Source an existing catalog part under supplier-owned baseline; apply appropriately lower evidence burden when risk supports it; preserve supplier spec and acceptance plan.

**AT-11 Sourcing C:** Source a modified supplier part, record base specification and delta/revision; document supplier acknowledgement and verification before source approval. Later standard supplier variation must not silently replace PDI-specific configuration.

**AT-12 Approval gates:** Attempt product-source approval with unqualified/suspended site, missing released requirements, missing validation, open blocking NCR or expired concession; show explicit failures. After resolving them, authorize and freeze approval; subsequent data edits cannot change frozen evidence.

**AT-13 Supplier suspension:** Suspend supplier or manufacturing site; flag at-risk prior approvals and blocked activities per chosen business policy, record decision and controlled reinstatement path.

**AT-14 Material concession:** Request use-as-is deviation limited to named lot, quantity and validity; obtain authorized approval; another shipment or later date must not inherit permission.

**AT-15 Supplier corrective action:** NCR triggers SCAR and 8D-like supplier response, including containment/root cause/action/effectiveness verification; an open SCAR stays visible after material disposition and does not disappear at NCR closure.

**AT-16 Change control:** Supplier proposes coating/process/site modification; compare old/new baselines, conduct impact assessment, require appropriate validation and decision, verify first implementation, preserve shipment-specific effectivity and complete history.

**AT-17 Documents/PPAP:** For a high-risk source, list required technical/qualification/supplier documents, satisfy or officially waive each, generate an approval/PPAP-related evidence package with exact revisions. For low-risk source, avoid unnecessary package requirements.

**AT-18 Ownership:** A supplier commits to an action during a call; assign owner/due date, remind and show overdue, record response and verification before closing. The supplier/product history shows the event.

**AT-19 Roles:** An inspector can inspect but cannot release an engineering drawing, secretly alter finalized results, grant their own restricted concession or approve a high-risk product without authority. An appropriately authorized cross-functional user can perform several approved functions.

**AT-20 Traceability:** Given part+lot or serial, retrieve applicable product/source approval, inspection answers/photos, exact form/spec revision, test/repair history, known earlier FAI defects, NCR/change history and decisions, with meaningful search and timestamps.

**AT-21 Failure recovery:** Interrupt editing with unsaved entries, encounter a failed photo upload and simulate a restarted report job; user sees clear state and can recover without duplicated or lost quality evidence. Restore a backed-up synthetic environment and validate complete evidence links.

## 15. Architecture assessment deliverables and exclusions
The proposed solution architecture should include: business capability map; domain and record relationship model; state/authorization gates; UX navigation/workspace proposal with inspection interaction wire-level description; implementation alternatives and tradeoffs; data security/audit/file design; integration boundaries; test plan; iterative implementation sequence; risks; scale and cost assumptions; explicit business policy questions and recommended defaults. Prefer simple, maintainable components for a small team without foreclosing growth.

**Do not implement anything as part of the initial architecture exercise.** No application code, configuration, databases, deployments or repository changes are authorized until PDI reviews and approves the design. The architect must clearly separate decisions it can independently make from business policies requiring approval.

## Appendix A and Appendix B
See the two companion **PDI TQMS clean-sheet appendices**, which supply the inspection form/characteristic vocabulary and controlled-document taxonomy. They are specifications of business content and desired interactions—not code, screen dumps or prescriptive data structures. These appendices are part of the requirements handoff.
