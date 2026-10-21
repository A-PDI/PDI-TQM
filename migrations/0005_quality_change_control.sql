-- Stage 3: NCR with scoped containment, disposition, verification and release; concessions
-- with bounded use; SCAR with supplier response revisions, independent implementation and
-- effectiveness verification and recurrence; supplier commitments; technical/supplier change
-- control; source-level restrictions; controlled form revision editing and one-off forms.

-- ---------------------------------------------------------------- source-level restriction
ALTER TABLE supplier_restriction ADD COLUMN source_id uuid REFERENCES source(id);
ALTER TABLE supplier_restriction DROP CONSTRAINT supplier_restriction_kind_check;
ALTER TABLE supplier_restriction ADD CONSTRAINT supplier_restriction_kind_check CHECK (kind IN ('SUSPENDED', 'RESTRICTED'));
ALTER TABLE supplier_restriction ADD CONSTRAINT supplier_restriction_scope_check
  CHECK ((kind = 'RESTRICTED') = (source_id IS NOT NULL) AND (source_id IS NULL OR site_id IS NULL));
DROP INDEX supplier_restriction_active_key;
CREATE UNIQUE INDEX supplier_restriction_active_key ON supplier_restriction
  (supplier_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE lifted_at IS NULL;

-- ---------------------------------------------------------------- controlled forms
ALTER TABLE form_revision DROP CONSTRAINT form_revision_status_check;
ALTER TABLE form_revision ADD CONSTRAINT form_revision_status_check
  CHECK (status IN ('DRAFT', 'IN_REVIEW', 'RELEASED', 'SUPERSEDED', 'OBSOLETE', 'ONE_OFF'));
ALTER TABLE form_revision
  ADD COLUMN based_on_revision_id uuid REFERENCES form_revision(id),
  ADD COLUMN submitted_by uuid REFERENCES app_user(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN release_rationale text;

CREATE OR REPLACE FUNCTION form_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft form revisions can be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.definition IS DISTINCT FROM OLD.definition
    OR NEW.definition_sha256 IS DISTINCT FROM OLD.definition_sha256
    OR NEW.revision_label IS DISTINCT FROM OLD.revision_label
    OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.form_id IS DISTINCT FROM OLD.form_id) THEN
    RAISE EXCEPTION 'form revision content is immutable once submitted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('SUPERSEDED', 'OBSOLETE', 'ONE_OFF') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'superseded, obsolete or one-off form revisions cannot change status' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Guard used by records whose decision, once recorded, is final.
CREATE FUNCTION final_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = ANY (TG_ARGV) THEN
    RAISE EXCEPTION '% % is final and immutable', TG_TABLE_NAME, OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- nonconformance
CREATE TABLE ncr (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  text NOT NULL UNIQUE,
  quality_event_id        uuid NOT NULL UNIQUE REFERENCES quality_event(id),
  title                   text NOT NULL,
  defect_description      text NOT NULL,
  failure_mode            text,
  characteristic          text,
  expected                text,
  actual                  text,
  part_id                 uuid REFERENCES company_part(id),
  supplier_id             uuid REFERENCES supplier(id),
  site_id                 uuid REFERENCES supplier_site(id),
  source_id               uuid REFERENCES source(id),
  inspection_id           uuid REFERENCES inspection(id),
  po_number               text,
  lot_number              text,
  severity                text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  owner_id                uuid NOT NULL REFERENCES app_user(id),
  confirmed_by            uuid NOT NULL REFERENCES app_user(id),
  confirmed_at            timestamptz NOT NULL DEFAULT now(),
  confirmation_rationale  text NOT NULL,
  recurrence_of_scar_id   uuid,
  status                  text NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN', 'CONTAINED', 'DISPOSITIONED', 'VERIFIED_RESOLVED', 'CLOSED')),
  closed_by               uuid REFERENCES app_user(id),
  closed_at               timestamptz,
  closure_note            text,
  version                 integer NOT NULL DEFAULT 1,
  CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND closure_note IS NOT NULL))
);
CREATE INDEX ncr_source_idx ON ncr (source_id, status);
CREATE INDEX ncr_part_idx ON ncr (part_id);
CREATE TRIGGER ncr_guard BEFORE UPDATE OR DELETE ON ncr
  FOR EACH ROW EXECUTE FUNCTION final_status_guard('CLOSED');

-- Physical material affected by an NCR: exact lot, quantity and serials. Holding material in
-- TQMS records the decision and its physical verification; it does not move ERP stock.
CREATE TABLE material_scope (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ncr_id                      uuid NOT NULL REFERENCES ncr(id),
  label                       text NOT NULL,
  lot_number                  text NOT NULL,
  po_number                   text,
  inspection_id               uuid REFERENCES inspection(id),
  quantity                    integer NOT NULL CHECK (quantity > 0),
  serial_numbers              text[] NOT NULL DEFAULT '{}',
  location                    text,
  containment_action          text NOT NULL,
  created_by                  uuid NOT NULL REFERENCES app_user(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  containment_authorized_by   uuid REFERENCES app_user(id),
  containment_authorized_at   timestamptz,
  segregation_verified_by     uuid REFERENCES app_user(id),
  segregation_verified_at     timestamptz,
  segregation_note            text,
  state                       text NOT NULL DEFAULT 'ON_HOLD'
                              CHECK (state IN ('ON_HOLD', 'SEGREGATED_VERIFIED', 'DECIDED', 'VERIFIED_RESOLVED', 'RELEASED')),
  version                     integer NOT NULL DEFAULT 1,
  CHECK (segregation_verified_at IS NULL OR (containment_authorized_at IS NOT NULL AND segregation_note IS NOT NULL)),
  CHECK (cardinality(serial_numbers) <= quantity)
);
CREATE INDEX material_scope_ncr_idx ON material_scope (ncr_id);
CREATE FUNCTION no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER material_scope_no_delete BEFORE DELETE ON material_scope FOR EACH ROW EXECUTE FUNCTION no_delete();
CREATE INDEX material_scope_lot_idx ON material_scope (lot_number);

-- ---------------------------------------------------------------- concession / deviation
CREATE TABLE concession (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               text NOT NULL UNIQUE,
  part_id              uuid NOT NULL REFERENCES company_part(id),
  source_id            uuid REFERENCES source(id),
  configuration        text,
  ncr_id               uuid REFERENCES ncr(id),
  inspection_id        uuid REFERENCES inspection(id),
  lot_number           text NOT NULL,
  po_number            text,
  quantity_limit       integer NOT NULL CHECK (quantity_limit > 0),
  characteristic       text NOT NULL,
  permitted_exception  text NOT NULL,
  conditions           text,
  justification        text NOT NULL,
  valid_from           date NOT NULL,
  valid_until          date NOT NULL,
  requested_by         uuid NOT NULL REFERENCES app_user(id),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  decided_by           uuid REFERENCES app_user(id),
  decided_at           timestamptz,
  decision_rationale   text,
  grants_used          text[],
  version              integer NOT NULL DEFAULT 1,
  CHECK (valid_until >= valid_from),
  CHECK (status IN ('REQUESTED', 'WITHDRAWN') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_rationale IS NOT NULL))
);
CREATE INDEX concession_lot_idx ON concession (part_id, lot_number);
CREATE TRIGGER concession_guard BEFORE UPDATE OR DELETE ON concession
  FOR EACH ROW EXECUTE FUNCTION final_status_guard('APPROVED', 'REJECTED', 'WITHDRAWN');

-- ---------------------------------------------------------------- disposition and verification
CREATE TABLE disposition_decision (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id        uuid NOT NULL REFERENCES material_scope(id),
  outcome         text NOT NULL CHECK (outcome IN ('RETURN_TO_SUPPLIER', 'SCRAP', 'REWORK', 'REPAIR', 'USE_AS_IS')),
  quantity        integer NOT NULL CHECK (quantity > 0),
  serial_numbers  text[] NOT NULL DEFAULT '{}',
  concession_id   uuid REFERENCES concession(id),
  instructions    text,
  rationale       text NOT NULL,
  decided_by      uuid NOT NULL REFERENCES app_user(id),
  decided_at      timestamptz NOT NULL DEFAULT now(),
  grants_used     text[] NOT NULL,
  voided_by       uuid REFERENCES app_user(id),
  voided_at       timestamptz,
  void_reason     text,
  CHECK ((outcome = 'USE_AS_IS') = (concession_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX disposition_decision_scope_idx ON disposition_decision (scope_id);

-- Decisions are immutable; a superseded decision is voided once with a reason and stays on record.
CREATE FUNCTION disposition_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disposition decisions cannot be deleted; void instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['voided_by', 'voided_at', 'void_reason']) <> (to_jsonb(OLD) - ARRAY['voided_by', 'voided_at', 'void_reason']) THEN
    RAISE EXCEPTION 'a disposition decision is immutable; only voiding may be recorded once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER disposition_decision_guard BEFORE UPDATE OR DELETE ON disposition_decision
  FOR EACH ROW EXECUTE FUNCTION disposition_decision_guard();

-- Defense in depth: active decisions never allocate more than the scope's quantity.
CREATE FUNCTION disposition_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated integer;
  total integer;
BEGIN
  SELECT coalesce(sum(quantity), 0) INTO allocated FROM disposition_decision WHERE scope_id = NEW.scope_id AND voided_at IS NULL;
  SELECT quantity INTO total FROM material_scope WHERE id = NEW.scope_id;
  IF allocated > total THEN
    RAISE EXCEPTION 'dispositions (%) exceed the affected quantity (%)', allocated, total USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER disposition_allocation_guard AFTER INSERT ON disposition_decision
  FOR EACH ROW EXECUTE FUNCTION disposition_allocation_guard();

CREATE TABLE disposition_verification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id    uuid NOT NULL REFERENCES disposition_decision(id),
  result         text NOT NULL CHECK (result IN ('VERIFIED', 'REJECTED')),
  method         text NOT NULL,
  inspection_id  uuid REFERENCES inspection(id),
  note           text NOT NULL,
  verified_by    uuid NOT NULL REFERENCES app_user(id),
  verified_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disposition_verification_decision_idx ON disposition_verification (decision_id);
CREATE TRIGGER disposition_verification_immutable BEFORE UPDATE OR DELETE ON disposition_verification
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE material_release (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id       uuid NOT NULL REFERENCES material_scope(id),
  quantity       integer NOT NULL CHECK (quantity > 0),
  concession_id  uuid REFERENCES concession(id),
  note           text NOT NULL,
  released_by    uuid NOT NULL REFERENCES app_user(id),
  released_at    timestamptz NOT NULL DEFAULT now(),
  grants_used    text[] NOT NULL
);
CREATE TRIGGER material_release_immutable BEFORE UPDATE OR DELETE ON material_release
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Each use of a concession consumes quantity; the total never exceeds its limit.
CREATE TABLE concession_use (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concession_id            uuid NOT NULL REFERENCES concession(id),
  quantity                 integer NOT NULL CHECK (quantity > 0),
  disposition_decision_id  uuid UNIQUE REFERENCES disposition_decision(id),
  inspection_id            uuid UNIQUE REFERENCES inspection(id),
  used_by                  uuid NOT NULL REFERENCES app_user(id),
  used_at                  timestamptz NOT NULL DEFAULT now(),
  released_at              timestamptz,
  CHECK ((disposition_decision_id IS NULL) <> (inspection_id IS NULL))
);
CREATE FUNCTION concession_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  used integer;
  lim integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concession uses cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.released_at IS NOT NULL OR (to_jsonb(NEW) - 'released_at') <> (to_jsonb(OLD) - 'released_at') THEN
      RAISE EXCEPTION 'concession uses are immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(quantity), 0) INTO used FROM concession_use WHERE concession_id = NEW.concession_id AND released_at IS NULL;
  SELECT quantity_limit INTO lim FROM concession WHERE id = NEW.concession_id;
  IF used > lim THEN
    RAISE EXCEPTION 'concession quantity exhausted (% of %)', used, lim USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER concession_use_guard AFTER INSERT OR UPDATE OR DELETE ON concession_use
  FOR EACH ROW EXECUTE FUNCTION concession_use_guard();

-- ---------------------------------------------------------------- supplier corrective action
CREATE TABLE scar (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              text NOT NULL UNIQUE,
  supplier_id         uuid NOT NULL REFERENCES supplier(id),
  site_id             uuid REFERENCES supplier_site(id),
  source_id           uuid REFERENCES source(id),
  part_id             uuid REFERENCES company_part(id),
  title               text NOT NULL,
  problem_statement   text NOT NULL,
  requested_actions   text,
  sent_to             text NOT NULL,
  sent_via            text NOT NULL CHECK (sent_via IN ('EMAIL', 'PORTAL', 'MEETING', 'CALL', 'MAIL', 'OTHER')),
  response_due        date NOT NULL,
  owner_id            uuid NOT NULL REFERENCES app_user(id),
  issued_by           uuid NOT NULL REFERENCES app_user(id),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  effectiveness_plan  text,
  cycle               integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'ISSUED'
                      CHECK (status IN ('ISSUED', 'RESPONSE_RECEIVED', 'IMPLEMENTATION_VERIFIED', 'EFFECTIVENESS_VERIFIED', 'CLOSED')),
  closed_by           uuid REFERENCES app_user(id),
  closed_at           timestamptz,
  closure_note        text,
  version             integer NOT NULL DEFAULT 1,
  CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX scar_supplier_idx ON scar (supplier_id, status);

-- A closed SCAR changes only by recurrence reopening it into a new cycle.
CREATE FUNCTION scar_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SCARs cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'CLOSED' AND NOT (NEW.status = 'ISSUED' AND NEW.cycle = OLD.cycle + 1) THEN
    RAISE EXCEPTION 'SCAR % is closed; only a recurrence can reopen it', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF NEW.cycle < OLD.cycle THEN
    RAISE EXCEPTION 'SCAR cycles only advance' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scar_guard BEFORE UPDATE OR DELETE ON scar FOR EACH ROW EXECUTE FUNCTION scar_guard();

ALTER TABLE ncr ADD CONSTRAINT ncr_recurrence_scar_fk FOREIGN KEY (recurrence_of_scar_id) REFERENCES scar(id);

CREATE TABLE scar_ncr (
  scar_id    uuid NOT NULL REFERENCES scar(id),
  ncr_id     uuid NOT NULL REFERENCES ncr(id),
  relation   text NOT NULL CHECK (relation IN ('ORIGIN', 'RECURRENCE')),
  linked_by  uuid NOT NULL REFERENCES app_user(id),
  linked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scar_id, ncr_id)
);
CREATE TRIGGER scar_ncr_immutable BEFORE UPDATE OR DELETE ON scar_ncr FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Supplier's stated position, kept as revisions (8D-like structure, not mandatory in full).
CREATE TABLE scar_response (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scar_id               uuid NOT NULL REFERENCES scar(id),
  revision              integer NOT NULL,
  cycle                 integer NOT NULL,
  received_at           timestamptz NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('EMAIL', 'PORTAL', 'MEETING', 'CALL', 'MAIL', 'OTHER')),
  representative        text NOT NULL,
  team                  text,
  problem_description   text,
  containment           text NOT NULL,
  root_cause            text NOT NULL,
  corrective_action     text NOT NULL,
  implementation        text,
  prevention            text,
  supplier_claims_done  boolean NOT NULL DEFAULT false,
  recorded_by           uuid NOT NULL REFERENCES app_user(id),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scar_id, revision)
);
CREATE TRIGGER scar_response_immutable BEFORE UPDATE OR DELETE ON scar_response FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE scar_verification (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scar_id          uuid NOT NULL REFERENCES scar(id),
  cycle            integer NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('IMPLEMENTATION', 'EFFECTIVENESS')),
  result           text NOT NULL CHECK (result IN ('VERIFIED', 'NOT_VERIFIED')),
  method           text NOT NULL,
  evidence         text NOT NULL,
  inspection_ids   uuid[] NOT NULL DEFAULT '{}',
  population_note  text,
  verified_by      uuid NOT NULL REFERENCES app_user(id),
  verified_at      timestamptz NOT NULL DEFAULT now(),
  grants_used      text[] NOT NULL
);
CREATE INDEX scar_verification_scar_idx ON scar_verification (scar_id, cycle);
CREATE TRIGGER scar_verification_immutable BEFORE UPDATE OR DELETE ON scar_verification FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE scar_reopen (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scar_id      uuid NOT NULL REFERENCES scar(id),
  ncr_id       uuid NOT NULL REFERENCES ncr(id),
  from_status  text NOT NULL,
  to_cycle     integer NOT NULL,
  reason       text NOT NULL,
  reopened_by  uuid NOT NULL REFERENCES app_user(id),
  reopened_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER scar_reopen_immutable BEFORE UPDATE OR DELETE ON scar_reopen FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- ---------------------------------------------------------------- change control
CREATE TABLE change_request (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                      text NOT NULL UNIQUE,
  origin                      text NOT NULL CHECK (origin IN ('PDI', 'SUPPLIER')),
  title                       text NOT NULL,
  description                 text NOT NULL,
  justification               text NOT NULL,
  categories                  text[] NOT NULL,
  part_id                     uuid NOT NULL REFERENCES company_part(id),
  supplier_id                 uuid REFERENCES supplier(id),
  site_id                     uuid REFERENCES supplier_site(id),
  current_revision_id         uuid REFERENCES baseline_revision(id),
  proposed_revision_id        uuid REFERENCES baseline_revision(id),
  supplier_reference          text,
  supplier_representative     text,
  desired_effective_date      date,
  affected_stock              text,
  requested_by                uuid NOT NULL REFERENCES app_user(id),
  requested_at                timestamptz NOT NULL DEFAULT now(),
  owner_id                    uuid NOT NULL REFERENCES app_user(id),
  status                      text NOT NULL DEFAULT 'PROPOSED'
                              CHECK (status IN ('PROPOSED', 'IMPACT_ASSESSED', 'APPROVED', 'REJECTED', 'EFFECTIVE', 'IMPLEMENTATION_VERIFIED', 'CANCELLED')),
  impact_summary              text,
  requalification_required    boolean,
  impact_assessed_by          uuid REFERENCES app_user(id),
  impact_assessed_at          timestamptz,
  decided_by                  uuid REFERENCES app_user(id),
  decided_at                  timestamptz,
  decision_rationale          text,
  conditions                  text,
  grants_used                 text[],
  effective_date              date,
  effective_lot               text,
  effective_note              text,
  made_effective_by           uuid REFERENCES app_user(id),
  made_effective_at           timestamptz,
  implementation_inspection_id uuid REFERENCES inspection(id),
  implementation_note         text,
  implementation_verified_by  uuid REFERENCES app_user(id),
  implementation_verified_at  timestamptz,
  cancel_reason               text,
  version                     integer NOT NULL DEFAULT 1,
  CHECK (cardinality(categories) > 0 AND categories <@ ARRAY['DESIGN', 'DIMENSION', 'MATERIAL', 'COATING', 'HEAT_TREATMENT', 'PROCESS',
    'EQUIPMENT', 'TOOLING', 'SUB_TIER', 'SITE', 'TEST_METHOD', 'ADMINISTRATIVE']::text[]),
  CHECK (status NOT IN ('APPROVED', 'REJECTED', 'EFFECTIVE', 'IMPLEMENTATION_VERIFIED') OR (decided_by IS NOT NULL AND decision_rationale IS NOT NULL)),
  CHECK (status NOT IN ('EFFECTIVE', 'IMPLEMENTATION_VERIFIED') OR (effective_date IS NOT NULL AND made_effective_by IS NOT NULL)),
  CHECK (status <> 'IMPLEMENTATION_VERIFIED' OR (implementation_verified_by IS NOT NULL AND implementation_note IS NOT NULL))
);
CREATE INDEX change_request_part_idx ON change_request (part_id, status);
CREATE TRIGGER change_request_guard BEFORE UPDATE OR DELETE ON change_request
  FOR EACH ROW EXECUTE FUNCTION final_status_guard('REJECTED', 'IMPLEMENTATION_VERIFIED', 'CANCELLED');

CREATE TABLE change_source (
  change_id  uuid NOT NULL REFERENCES change_request(id),
  source_id  uuid NOT NULL REFERENCES source(id),
  PRIMARY KEY (change_id, source_id)
);

CREATE TABLE change_impact_item (
  change_id    uuid NOT NULL REFERENCES change_request(id),
  area         text NOT NULL CHECK (area IN ('DRAWING', 'VALIDATION_FAI', 'INSPECTION_PLAN', 'SOURCE_APPROVAL', 'SUPPLIER_ACKNOWLEDGMENT',
                 'STOCK_WIP', 'SUPPLIER_COMMITMENTS')),
  affected     boolean NOT NULL,
  assessment   text NOT NULL,
  PRIMARY KEY (change_id, area)
);

CREATE TABLE change_action (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id            uuid NOT NULL REFERENCES change_request(id),
  kind                 text NOT NULL CHECK (kind IN ('BASELINE_RELEASE', 'REQUALIFY_FAI', 'NEW_ACKNOWLEDGMENT', 'SOURCE_REAPPROVAL',
                         'UPDATE_INSPECTION_FORM', 'STOCK_REVIEW', 'OTHER')),
  title                text NOT NULL,
  owner_id             uuid NOT NULL REFERENCES app_user(id),
  due_date             date,
  waivable             boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'WAIVED')),
  completion_note      text,
  completed_by         uuid REFERENCES app_user(id),
  completed_at         timestamptz,
  created_by           uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'OPEN' OR (completed_by IS NOT NULL AND completion_note IS NOT NULL)),
  CHECK (status <> 'WAIVED' OR waivable)
);
CREATE INDEX change_action_change_idx ON change_action (change_id);
CREATE TRIGGER change_action_no_delete BEFORE DELETE ON change_action FOR EACH ROW EXECUTE FUNCTION no_delete();

-- ---------------------------------------------------------------- supplier commitments
CREATE TABLE supplier_commitment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE,
  supplier_id           uuid NOT NULL REFERENCES supplier(id),
  site_id               uuid REFERENCES supplier_site(id),
  source_id             uuid REFERENCES source(id),
  part_id               uuid REFERENCES company_part(id),
  baseline_revision_id  uuid REFERENCES baseline_revision(id),
  scar_id               uuid REFERENCES scar(id),
  ncr_id                uuid REFERENCES ncr(id),
  change_id             uuid REFERENCES change_request(id),
  representative        text NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('CALL', 'EMAIL', 'MEETING', 'VISIT', 'PORTAL', 'OTHER')),
  communicated_at       timestamptz NOT NULL,
  statement             text NOT NULL,
  promised_action       text NOT NULL,
  expected_outcome      text,
  verification_method   text NOT NULL,
  owner_id              uuid NOT NULL REFERENCES app_user(id),
  due_date              date,
  no_date_reason        text,
  severity              text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE', 'VERIFIED', 'CANCELLED')),
  recorded_by           uuid NOT NULL REFERENCES app_user(id),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  closed_by             uuid REFERENCES app_user(id),
  closed_at             timestamptz,
  version               integer NOT NULL DEFAULT 1,
  CHECK (due_date IS NOT NULL OR no_date_reason IS NOT NULL),
  CHECK (status NOT IN ('VERIFIED', 'CANCELLED') OR (closed_by IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE INDEX supplier_commitment_supplier_idx ON supplier_commitment (supplier_id, status);
CREATE INDEX supplier_commitment_due_idx ON supplier_commitment (status, due_date);
CREATE TRIGGER supplier_commitment_guard BEFORE UPDATE OR DELETE ON supplier_commitment
  FOR EACH ROW EXECUTE FUNCTION final_status_guard('VERIFIED', 'CANCELLED');

CREATE TABLE commitment_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id  uuid NOT NULL REFERENCES supplier_commitment(id),
  kind           text NOT NULL CHECK (kind IN ('NOTE', 'SUPPLIER_UPDATE', 'SUPPLIER_CLAIM', 'VERIFIED', 'VERIFICATION_FAILED',
                   'REMINDER', 'ESCALATED', 'DUE_DATE_CHANGED', 'CANCELLED')),
  note           text NOT NULL,
  inspection_id  uuid REFERENCES inspection(id),
  reminder_day   date,
  actor_id       uuid REFERENCES app_user(id),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('REMINDER', 'ESCALATED')) = (reminder_day IS NOT NULL))
);
CREATE INDEX commitment_event_commitment_idx ON commitment_event (commitment_id, occurred_at);
CREATE UNIQUE INDEX commitment_event_reminder_key ON commitment_event (commitment_id, kind, reminder_day) WHERE reminder_day IS NOT NULL;
CREATE TRIGGER commitment_event_immutable BEFORE UPDATE OR DELETE ON commitment_event FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- ---------------------------------------------------------------- unified work queue
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN (
  'INSPECTION_ASSIGNED', 'INSPECTION_REVIEW', 'CONCERN_TRIAGE', 'CONCERN_FOLLOW_UP',
  'QUALIFICATION_DECISION', 'BASELINE_RELEASE', 'FAI_DECISION', 'SOURCE_APPROVAL', 'SUPPLIER_RESPONSE', 'SOURCING_REQUEST',
  'NCR_ACTION', 'CONTAINMENT_AUTHORIZATION', 'SEGREGATION_VERIFICATION', 'DISPOSITION_DECISION', 'DISPOSITION_VERIFICATION',
  'MATERIAL_RELEASE', 'CONCESSION_DECISION', 'SCAR_RESPONSE', 'SCAR_VERIFICATION', 'COMMITMENT_FOLLOW_UP', 'COMMITMENT_ESCALATION',
  'CHANGE_IMPACT', 'CHANGE_DECISION', 'CHANGE_ACTION', 'CHANGE_VERIFICATION', 'FORM_RELEASE'));
