# Construction Drawing C — End-to-end domain workflows and gates

## C1. Core rules carried by every workflow

Every business event has a meaningful origin/subject, active owner where follow-up is required, user/timestamp, evidence references, reason and an append-only history. Any 'accepted/approved/closed' label is a view of valid underlying decisions, never a user-editable status string bypass. Do not turn preliminary reports into released specifications. A physical quarantine, shipment release or stock movement exists outside TQMS until its physical verification or an explicitly authorized ERP integration is recorded. Clear separation: observed inspection PASS/FAIL/ACCEPTED vs. independently authorized material disposition and product/source approval.

## C2. Receiving — from receipt to frozen report and disposition

1. Technician selects part (or legitimate one-off), number of sampled units, purchase reference/date. System suggests released form and exact source when available and captures supplier/site/lot/quantity/serial; captures on a restricted source stay on hold.
2. Snapshot the form/technical baseline identity for new inspection. Show A shared once, B/C for each unit. Save partial on every ordinary edit, with retry on conflict; attachments through private upload validation.
3. Accept explicit P/F/A/N according to section semantics. For Fail/Accepted, require observations and characteristic-specific photo; a dimensional recorded value compares only with authorized compatible units/limits. A missing spec is explicitly unresolved Engineering review, not automatic PASS.
4. Completion checks per-unit required rows, applicable special geometry, evidence, source/revision and independent review. If complete, freeze the inspection and render original PDF; keep hold/release separate. Completed record amendment is attributable and original report immutable.
5. Suspected defect opens linked observation and Engineering triage. Confirmed nonconformity routes specific material scope into containment, disposition and optional SCAR; technician cannot silently authorize use-as-is.

## C3. Source qualification — three distinct sourcing paths

**A — PDI-created design / reverse engineered / supplier not previously making it:** intake may start with missing dimensions; Engineering owns released drawing/spec revision and inspection/test method. Establish supplier and **exact site**, capability, FAI/validation plan, supplier acknowledgment of released revision, objective first article (rejected remains in history if replaced), production readiness. All critical requirements and risks must be assessed before authorization.

**B — existing supplier catalog product unmodified:** retain supplier-owned baseline/specification, cross reference to PDI item, site/supplier part exactness and risk-proportional validation; do not require full customer design engineering by default. Still needs an explicit product-source authorization for the exact scope.

**C — supplier's existing product with PDI change:** retain supplier standard baseline **plus PDI's controlled delta** (material, finish/coating, machining, heat treatment, critical values or process), issue revision, record exact supplier acknowledgment, FAI/validation and conditions. Supplier's future standard part update cannot silently override the PDI configuration. Follow any later coating/plant change through change control.

Across paths, qualification for Supplier/site, approved requirements, FAI/tests, commercial/source master and material acceptance remain distinct. An approved supplier alone is not enough. A new site or changed configuration must be assessed separately. Rejected first article persists and can trigger recurrence analysis when the original defect resurfaces after production release.

## C4. Supplier-site approval, exact source approval and frozen evidence

Proposal -> applicable evidence checklist (only required/conditional for pathway, criticality and customer) -> Engineering released specification -> supplier/site assessment -> supplier acknowledgment -> sample/validation chain -> independent authorization. Gate evaluation must identify missing/mismatched documents, dates, approvals, wrong site, wrong revision, open blocking NCR and expired concession. Recheck at transaction time. Store approval Decision frozen manifest of exact evidence IDs/hashes and governing policies. Later restrictions visibly block new activity per policy without rewriting historical approvals. Pending technical/quality policy decisions cannot default into real operational release.

## C5. Quick concern -> NCR -> material scope -> SCAR

- One-click quick concern needs title, description, owner and optional known part/supplier; Engineering can identify records later and confirm or reject with reason.
- Confirmation creates attributable NCR and links original inspection responses/photos; do not clone unlinked blobs; identify affected lot, exact units/quantity and failure mode.
- Management authorizes containment scope; person on site physically verifies segregation/hold; visible held material does not imply warehouse/ERP status change.
- Record separate material disposition by unit/quantity: return, scrap, rework, repair or bounded use-as-is. 'Accepted' requires exact current concession when policy calls for it, with expiry/quantity/conditions and permitted authorizer. Do not accept a single-item sample as blanket lot disposition.
- For rework/repair, objective PDI original verification or appropriate passing reinspection must prove affected unit + failed characteristic now meet governing criterion. A passing **replacement lot** is not proof original material was reworked. Supplier claims are not PDI verification.
- NCR can close after local material disposition/verification when policy allows, while supplier SCAR and source restrictions stay open separately.
- SCAR contains supplier explanation/revisions, containment, root cause, action, supplier commitment, PDI independent implementation proof and independent effectiveness plan/results. Effectiveness test should cover representative later production evidence, not only an immediate replacement sample; policy determines minimum population/time/alternative method. An '8D-like' template is available, not mandatory for trivial concerns. Recurrence links new NCR to prior SCAR, keeps frozen prior outcomes, and reopens owned actions for verification.

## C6. Supplier communication and commitments

Every promise has supplier representative, channel/date, statement or original document, exact product/source/revision, intended action, owner, target, expected verification method and any risk escalation. Supplier 'complete' is a claim state only. A PDI reviewer verifies objective outcomes; overdue commitments appear in the same My Work queue as inspection reviews, CAPA and change implementation, not another task subsystem. Preserve original/revised communications, disagreement and clarification.

## C7. Technical and supplier-process change

Capture request (PDI or supplier), old vs proposed requirements, scope (design/material/coating/heat treat/tooling/process/machine/sub-tier/site/test method), justification, desired effective date, affected lots/PO/current inventory. Engineering evaluates effect on drawing, validation/FAI, sampling, source approval, supplier acknowledgments, stock and supplier commitments; flags required requalification with owners. Decision release of new revision is separate from physical/process implementation verified on first conforming lot. Keep old effective applicability and old records readable. Material affected before effectivity cannot retroactively inherit approval.

## C8. Document and evidence lifecycle

Business records natively capture forms (not PDF attachment-only); document types and revision numbering in Appendix B; upload original engineering PDFs/photographs/CSV retains immutable bytes, hash, MIME, dimensions/date/uploader, linkage and visibility. File validation shall reject malicious/suspicious content, forbidden/oversize types and decompression bombs; scanner status visible to administrator only when needed. Only available/classified originals can satisfy gates. Generate PDI-branded controlled PDF editions and preserve earlier renditions unchanged. A supplier-uploaded document is not an internally verified one, and a link to a document is not an acknowledgment that exact released revision was read.

## C9. Injector bench, test, repair and quality analysis

Track serialized injector by company and OE part and unique serial; import machine data through a file adapter first, preserving original bytes and machine/test plan identity. Display every test event chronologically (date, machine, operating conditions and raw/derived measures), distinct first test, intermediate retests and final shipment evaluation. Repair case links action, replaced component, current setting/preload/stroke/lift/measurement, technician and subsequent test. Quick-entry measurement view optimized for shop. Need pass/fail rule provenance (machine's criteria vs released PDI criteria) and no unsupported assumptions. Search/compare multiple selected injectors and produce PDI-branded inspection/comparison/shipment PDF+spreadsheet. Metrics: first-pass yield, post-repair yield, retest counts, failure mode and throughput with clear denominators. No live CarbonZapp test-bench protocol, direct machine integration or automatic shared spreadsheet writes until sample data, field/units and authorized external destinations are provided and validated.

## C10. Reporting/management and retrieval

Role-aware dashboard shows actual remaining work and risks; comprehensive search across business aliases/PO/serial/form and document IDs. Drill-down preserves filters; row links to originating evidence and revision. Operational metrics must have documented definitions and reflect same data as detail records. Scheduled reminders use DB outbox/job with retry and explicit failure. Controlled PDFs have original issuance and version, PDF exports are authorized, CSV exports escape formula injection. Report summaries never imply certification or general process capability from an isolated passed inspection.

## C11. Legacy evaluation lessons converted into requirements

Old QMS strengths: practical per-unit inspection controls, flexible forms, autosave, photo/UI, shop reporting and injector capabilities. Old QMS defects: per-user page permissions frequently only browser-enforced; deletion/editing completed inspections and some reporting/admin endpoints insufficiently protected; alerts/state could become inconsistent; template changes could disturb historical meaning. All of these become mandatory negative API tests and immutable snapshots.

Old SQMS strengths: supplier/site/source/configuration separation, typed qualification workflows, change control, attributable approvals, evidence integrity and server-side gates. Old SQMS limits: initial implementation largely unverified in browser/infrastructure; missing/back-link navigation, invalid dialog roles, unavailable supplier-part screens, underpowered document authoring screens, partial NCR closure placeholders, excess setup burden, many complex containers. Do not reproduce defects, infrastructure complexity or configuration-first UX. Independently implement the outcome in one streamlined Render-native application.
