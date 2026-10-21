-- Stage 5: "only one open X" rules enforced by the database, so simultaneous requests cannot
-- both pass a check-then-insert in the service layer (Construction Drawing F1 concurrency cases).

CREATE UNIQUE INDEX repair_case_one_open ON repair_case (injector_id) WHERE status = 'OPEN';

CREATE UNIQUE INDEX supplier_qualification_one_under_review ON supplier_qualification
  (supplier_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'UNDER_REVIEW';

CREATE UNIQUE INDEX baseline_revision_one_draft ON baseline_revision (baseline_id) WHERE status IN ('DRAFT', 'IN_REVIEW');

CREATE UNIQUE INDEX form_revision_one_draft ON form_revision (form_id) WHERE status IN ('DRAFT', 'IN_REVIEW');

CREATE UNIQUE INDEX supplier_acknowledgment_one_pending ON supplier_acknowledgment (source_id) WHERE response = 'PENDING';

CREATE UNIQUE INDEX fai_sample_one_open ON fai_sample (source_id) WHERE status = 'OPEN';

CREATE UNIQUE INDEX quality_event_one_open_per_row ON quality_event (inspection_id, unit_index, section_key, row_key)
  WHERE status IN ('CAPTURED', 'TRIAGED') AND inspection_id IS NOT NULL AND row_key IS NOT NULL;

CREATE UNIQUE INDEX sourcing_request_one_per_source ON sourcing_request (source_id) WHERE status <> 'CANCELLED' AND source_id IS NOT NULL;
