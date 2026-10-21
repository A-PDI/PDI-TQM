# Construction Drawing F — End-to-end acceptance tests, evidence and sign-off

## F1. Invariant definition of 'done'

The whole TQMS is not ready merely because a UI loads or an agent says work is complete. A capability is accepted only when a named user can finish a realistic end-to-end task from ordinary UI, server/API tests deny unauthorized paths, stored audit history and evidence survive a restart and complete disaster-recovery drill, generated PDF is correct, and regression tests prove no previous section broke. Distinguish **implemented**, **unit-tested**, **integration-tested**, **UI-tested**, **staging-tested**, **PDI-approved** and **production-released** as different states. Every release gate has approver, date, build hash and demonstrable evidence.

### Global acceptance matrix / artifacts

- Source traceability: each FR-001...FR-116 (applicable IDs in Functional Specification) and each AT-01...AT-21 mapped to implemented code feature, test ID, exact record/fixture and signed result. No blanket 'covered by dashboard' row.
- Unit/domain: measure comparisons, form/requirement revision pins, sampling policy display, scope quantity allocation, expiry, authority and independence, timezone/date, permissions, immutable outcome.
- API/integration: direct unauthenticated and wrong-capability attempts on **every** sensitive read/write, report and file; invalid/mismatched source/site/lot, concurrency, duplicate importer, direct status tampering, interrupted job, corrupt evidence, failed disk.
- E2E: browser viewport 1440 desktop, ~390 mobile, accessible keyboard-only flows, empty state and failed form validations, real phone camera/upload where possible, back navigation and deep-link preservation, 100-unit inspection, saved draft after reload.
- PDF: render and compare representative output visually for piston, 12-unit liner, accepted cylinder head, accepted three-unit crankshaft, failed bearing, image-heavy turbo, NCR and SCAR. Verify all measurements and items, page count/headings, no clipping/overlapping, correct PDI footer/title/dated fields and file hashes upon rerender/redeploy. Visual regression image baseline maintained.
- Data/recovery: cold application bootstrap, migration rollback strategy, production-like staging restart, private file persistence, PG+disk independent backup and isolated restore. Re-run identity/audit/evidence hashes before/after.
- Operational: correct Render budget/resource boundaries, backup/restore ownership, file capacity alarms, security/MFA decision, job retries, logs with no confidential leakage, PDI role training and acceptance signoff.

## F2. Mandatory functional-specification acceptance cases (verbatim)

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


## F3. Required additional adversarial/negative cases

| ID | Attempt | Required result |
|---|---|---|
| NEG-01 | Technician calls management disposition API directly | Access denied; no decision or material release |
| NEG-02 | Inspector edits completed/frozen results by API | Denied; amendment creates linked revision preserving original |
| NEG-03 | Rev B form released while Rev A inspection exists | Rev A original/report unchanged; new B starts only where effective |
| NEG-04 | Source approved at Site A but item arrives from Site B | Not inheriting Site A permission, hold/triage |
| NEG-05 | Product approval requested with missing spec/site proof/FAI/mismatched files | Explicit actionable gate failures, no partial authorization |
| NEG-06 | Accepted measurement no authorized current concession | Cannot use status choice to release actual material |
| NEG-07 | Supplier notes 'corrected' without PDI verification | Commitment/SCAR implementation not verified or closed |
| NEG-08 | One reworked lot relabeled with passing replacement lot proof | Reject evidence mismatch, retain local hold |
| NEG-09 | Duplicate import of same bench test/event | No duplicate test; original raw remains unchanged |
| NEG-10 | Upload forged PDF, HTML disguised as photo, traversal pathname or oversized photo | Reject/quarantine without serving the bytes |
| NEG-11 | Authenticated file URL copied to another user/session | No unauthorized download |
| NEG-12 | Evidence disk absent/read-only/full at startup | Readiness fails clearly; never fallback ephemeral |
| NEG-13 | Staging update/redeploy after saving partial and finalized PDF | Session according to policy, draft, PDF original and evidence unchanged |
| NEG-14 | Backup PG but not evidence disk | Restore workflow reports incomplete/not validated, not success |
| NEG-15 | 100-item multi-unit inspection on mobile | No lost state/overflow, per-item fields accessible and report correct |
| NEG-16 | Unreleased technical limit and reported PASS in sample history | No validated pass inference; separate review/hold required |
| NEG-17 | Change in vendor site/processing coating mid-stream | Explicit current source impact assessment and requalification/condition |
| NEG-18 | 'Completed' generic task invoked to close open NCR/SCAR | Rejected; genuine verification/closure gates still enforced |
| NEG-19 | No authorized second reviewer present during private staging | Independent action remains blocked, not role-switched by one account |
| NEG-20 | Historical inspection sample contains employee name/photo/site identity | Never used in public fixtures; restrict reference originals |
| NEG-21 | User clicks every visible nav/action/approve/generate/Back control | No dead links, wrong route, empty wizard or ghost capabilities |
| NEG-22 | Import interrupted halfway through evidence manifest | Idempotent safe resume or explicit reconciliation without duplicates |
| NEG-23 | Human clicks 'Pass All' after entering known Fail | Confirmation required; protected failing data not silently erased |
| NEG-24 | Inspector marks one row N/A and leaves another blank | Blank is not N/A; completion identifies required row |

## F4. Final signed release checklist

Production authorization requires real PDI signoffs for inspection accuracy/UX, Engineering/specification authority, Purchasing/source workflow, Management disposition/SCAR, platform owner security, evidence storage/offsite restore, Render pricing and capacity, training, and change freeze/cutover. Record defects, severity and remediation. Deployment of a private staging app or use of illustrative synthetic records does not certify the quality management system or release products for sale.
