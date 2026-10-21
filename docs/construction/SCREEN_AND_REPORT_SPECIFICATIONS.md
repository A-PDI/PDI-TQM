# Construction Drawing B — Information architecture, user experience and PDI-branded outputs

## B1. What the finished application must feel like

A fast, professional operations workbench, not a programmer's testing harness and not a generic enterprise ERP wizard. PDI initially has approximately seven internal users and overlapping jobs; an inspector should not need to learn supplier qualification to inspect ten pistons. Preserve the simplicity that worked in the older operational QMS (sticky identity header, rapid Pass/Fail/Accepted buttons, per-unit tabs, inline photos, responsive forms, search/typeahead, one-click PDF), while addressing its backend permission flaws. Preserve the strong authority/traceability ideas of the old SQMS, but do not transplant its overlong wizards, placeholder screens, JSON configuration interfaces, or duplicate entity registers.

### Five-second test

An authorized user entering **Inspections** sees a prominent New Inspection action, useful inspections list, search/filter, and completed/pass/fail/incomplete status. Starting a known part opens a compact launch. No routine screen begins with cryptic UUIDs, fixture disclaimers, engineering revision selectors or setup policy vocabulary. Those belong under `Details`, `History` or restricted administration. A narrow **STAGING** indication is enough in a private demo; do not repeat a warning on every section.

## B2. Final navigation contract (broad capability, uncluttered presentation)

Eight destinations, visible based on grants and device width, but groups/tabs should be role-aware rather than rigidly cramped top-bar buttons:

1. **Home / My Work** — my assigned work, actionable overdue, exceptions and most recently used records. Management toggle for team-wide work.
2. **Inspections** — new, assigned, all, drafts, released form administration (authorized only), one-off inspections.
3. **Quality** — quick concerns, NCRs, hold/disposition/concessions, SCARs, alerts, recurrence.
4. **Parts & Sources** — company parts/aliases, supplier products, exact sources, technical baselines, FAI/validation, sourcing projects and source approval. A single hub, not separate duplicate parts registers.
5. **Suppliers** — supplier and sites, scope qualifications, certificates, contacts, commitments.
6. **Injectors** — serialized test/repair/search/quick-entry/analyses (no fake bench interface).
7. **Changes** — internal/supplier changes, revision/implementation, stock effectivity, impact and requalification.
8. **Reports** — management and operational drill-down, permission-filtered exports.

**Global** (not top-level duplicate screens): Search, '+ Capture' and user/account menu. **Administration** appears only for authorized administrators (user grants, policy versions, form publishing, record numbering, retention and system health). Controlled documents are visible contextually across subject hubs plus one optional `Documents` filtered entry; do not build a separate top-level view for every ENG/OPS/SUP form. A collapsible sidebar or compact adaptable tabs are acceptable if consistent across desktop and mobile. Never hide unimplemented destinations as if functional.

## B3. Dashboard specification

Immediate content: my due/overdue reviews, assigned inspections, drafts, supplier promised actions, unresolved high-risk quality holds, pending authorizations and recent records. Each count/card is a link to the precise filtered register, not a disconnected demo page. From Home -> failed bearing -> applicable inspection -> evidence/photo -> quality/NCR detail -> source restrictions -> Back returns to the filtered list with state preserved. Provide clear empty states that offer the next operation, not alarmist red warnings for normal emptiness.

At minimum search by part, OE alias, supplier/site, supplier PN, PO, lot, serial, inspection ID, NCR, SCAR, document, source, injector test, text; permissions applied before results. Dashboard totals and report totals share definitions and time-zone/display semantics.

## B4. Inspection list, launch and workbench — wire-level contract

**List:** default to recent records, searchable part/PO/date/status/inspector, useful sort and status, a single New Inspection. UUID/fixture IDs hidden by default. Row click navigates detail. Support bookmarked deep links. Performance with hundreds/thousands of historical inspections.

**Launch:** a single compact panel in familiar work order: `Part Number [typeahead]` -> auto-filled description -> suggested `Inspection Form` -> `Number of Items (1–100)` -> `PO Number` -> `Date Received` -> default `Inspector`; use contextual expandable supplier/site, lot/receipt quantity and sampling inputs when relevant. Missing formal supplier/tech data must be visible but should permit restricted capture, not falsely authorize source acceptance. New unknown parts may use a governed one-off inspection.

**Workbench header:** sticky component + business part + form/revision + PO/receipt + inspector + current unit + save state; primary `Save / Save as Partially Complete`, `Complete Inspection`, `PDF/Print`, `Close`. Save changes automatically with recoverable errors and optimistic concurrency. Preserve nested state on back/forward and unit navigation.

**Section A** once per inspection: receiving and documentation. **Sections B/C** per unit with numbered/serial-labeled tabs `Item 1` through `Item N`, Previous/Next, keyboard navigation, sticky unit context when scrolling. P/F/A/N controls sized for touch with text semantics, strong selection feedback; selecting a choice again may clear while editable. N/A is deliberate, not unanswered. Notes/photo associated with each exact row. `Fail` or `Accepted` requires meaningful observation and image with inline validation. Photos add/capture/preview/retry/delete until finalized; general gallery supplementary. `Pass All` fills **only the intended visual subset**, asks confirmation if replacing any existing answers, does not complete dimensional or missing-required entries. There is never a global 'approve all material' shortcut.

**Dimensional:** render labels, measurement location/method, released numeric spec and unit when available, Actual 1–3 or specialized form geometry; keep source precision; show derived status only for reliable released limits. If unknown, show `Specification not released — Engineering review required` in one local meaningful notice; allow readings, but no calculated certified PASS or independent acceptance. Protect against invalid numeric precision, unrecorded units, hidden missing data or incorrect conversion. Relevant Appendix A specialized sections: camshaft bore series; fire-ring protrusion; groove specs; six-cylinder valve recession (Int1/Int2/Exh1/Exh2); per-cylinder vacuum with conditional valve failures; oil cooler/vacuum checks; and each named pattern as detailed by form.

**Completion errors:** exact row and unit navigation links e.g. `Item 3 → Visual → Ring Groove Width: acceptance note is missing` or `Item 2 → Valve Recession C4: governing limit unavailable`. Do not surface generic giant staging warnings. Preserve partial data if completion fails. Distinguish **inspection outcome** (reported PASS/FAIL/ACCEPTED), **review status** and **material authorization**; separate actions/screens where authority actually matters.

**Finished report:** one-click frozen branded PDF, downloadable after redeploy/restoration. Include all recorded values/photos, per-unit outcomes, exception comments, form revision and evidence provenance, accurate dates and approvals. No blank fake `N/A` on missing PO, no suggested numerical limits invented, no statement implying that an old acceptance was automatically approved by the new system.

## B5. Other workspace specifications

**Parts/Source hub:** search header; company identity, aliases, engineering definition current vs historical, exact supplier+site+configuration combinations and statuses, FAI/qualifications/approvals, open NCR/change, lots and tests, comments/commitments, bounded active actions. Technical/editor tabs and release gates only to authorized users. User can click from affected product to the exact supplier-site source and historical evidence without re-entry.

**Supplier/Site hub:** organization overview, each site and scope status, current/expiring certificates, source relationships, commitments promised by named representatives with due dates and verification, qualification history, problems/SCARs. Display parent qualification and each site separately.

**Sourcing:** simple intake first, can start missing drawing, pathway A/B/C selected with plain-language explanation; show applicable checklist and its rationale, not every ENG/VAL/SUP document as universal burden. Engineering revision and supplier acknowledgment are exact objects. FAI result, rejected replacement sequence, validations and Gate-by-gate approval screen including actionable missing evidence.

**Quality:** 'Record a concern' short capture, then triage; NCR scope/units/containment; supplier SCAR response revisions, independent implementation/effectiveness, recurrence timeline; management scoped disposition screen with summary of what will be authorized, lot/quantity/expiry/conditions and required evidence. Keep a single action queue.

**Changes:** compare baseline before/after, show which sites/sources/parts/stock/lots/tests affected; approval separate from implementation verification; required FAI/requalification controls; effective-on-lot/date traceability.

**Injectors:** serialized search, imported tests grouped chronology, machine/test conditions, numeric parameters and graphs for selected test conditions, repair history, fast measurement entry, retest attribution, comparison/shipment reports; source imported file linked and immutable; idempotency on retransmission; unsupported bench protocol displayed as not integrated, never simulation advertised as production.

**Reports/Admin:** meaningful filters with drilldowns; report PDF/XLSX/CSV (as appropriate); structured admin editor with review/publish/rollback, not raw JSON blocks on operational UI; lifecycle, grant audit, role independence and inactive users.

## B6. PDI visual system — application and PDF

The eight supplied PDI inspection PDFs demonstrate an actual identifiable visual language: **deep navy header with white PDI logo left**, centered uppercase white `INCOMING QUALITY INSPECTION`, muted secondary `PDI-IQI-00x · COMPONENT · REV`, white page body, small gray metadata labels in two-column grids, charcoal text, pale-gray shaded section headings and alternating row stripes, thin table lines, navy item-dividers, PASS green checks/bar, FAIL red X/status, ACCEPTED amber 'A', and a restrained footer with PDI Quality Control, document number, `Page x of y` and issuance date. Use these as reference. Maintain high contrast and accessibility; icons must have textual result labels in accessible interfaces.

**Suggested initial digital design tokens to be verified against approved brand guide:** navy `#1E2D50` (reference approximation, not independently approved); navy dark `#152440`; slate `#4B5563`; border `#D8DDE5`; gray section `#ECEFF3`; light row `#F8F9FB`; green `#229A61`; amber `#BB8427`; red `#C63B33`; white `#FFFFFF`. Use color as supplemental meaning. One restrained type family (approved corporate font if provided; otherwise system sans). Default density deliberately compact on desktop (many characteristic rows) while 390px mobile has no sideways page overflow and touch targets are comfortably tappable. Favor semantic hierarchy over large colored callouts.

**PDF template geometry:** US Letter portrait unless document content demands landscape; 0.4–0.55 inch margin, ~0.60–0.80 inch navy top masthead with logo, document title and form ID, metadata grid beneath, section bars with left navy rule, characteristic/requirement/notes/result columns, row stripes and page numbers. Repeat column headers on continuation; prevent rows/photo captions from splitting in unreadable ways; clearly label continuation; keep a multi-unit result on or beside its unit's final row. Capture complete header, governing revision, date, approval and file references; paginate dozens of photos deliberately and compactly, avoid giant blank pages. All outputs should be generated from immutable structured snapshots rather than uploaded templates only.

**Document families:** distinct, coordinated PDI-branded templates for inspections; supplier/site assessments; ENG drawings/changes; FAI/validation; NCR (OPS-06); SCAR/8D (OPS-07); effectiveness (OPS-08); source approval; concession; supplier acknowledgment and supplier commitments. Each includes the controlled-document metadata applicable to its family. The original 37-form concept is a catalogue of record types and statuses, not a mandate to force 37 unrelated separate screens.

## B7. Language and UX acceptance rules

Use business nouns. Say `Part`, `Inspection`, `Supplier`, `Site`, `Form`, `Revision`, `Measurements`, `Photographs`, `Actions`, `Release`; do not expose `synthetic form context fixture`, `hash gate`, `UUID`, `normalized command`, `released technical baseline association fixture` or development origin details in routine flow. One discreet environment indicator visible only outside production. Save state visible in one place. Technical provenance accessible on demand under `Details`. Use inline guidance only at the relevant decision, with explicit 'why blocked/how to resolve.' No misleading placeholders or dead buttons. All links and buttons work, including direct URLs and back navigation. Screen-reader labels, keyboard controls, accessible errors and visible focus required.

## B8. Explicit examples / negative UX tests

A 12-unit liner and a 10-unit piston must remain manageable, with unit tabs/Previous/Next and no lost readings; a 6-cylinder head report prints all valve recession and vacuum results; a failed bearing record displays notes, photos and quarantine **as source-reported history**, not a newly authorized TQMS material block; an accepted crankshaft shows Item 1 ACCEPTED and Items 2–3 PASS, with overall accepted outcome but no implied current concession grant; a turbocharger with many photos has a usable gallery and orderly multi-page print. A separate current synthetic workflow must demonstrate actual regulated authorization/gates.
