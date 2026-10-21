-- Stage 2: supplier/site qualification and restrictions, certificates, technical baseline
-- authoring/release, A/B/C sourcing with risk and evidence checklists, supplier
-- acknowledgments, first-article/validation samples, and gated exact-source approval.

-- ---------------------------------------------------------------- technical baselines
ALTER TABLE baseline_revision
  ADD COLUMN base_revision_id uuid REFERENCES baseline_revision(id),
  ADD COLUMN submitted_by uuid REFERENCES app_user(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN release_rationale text;
ALTER TABLE baseline_characteristic
  ADD COLUMN is_delta boolean NOT NULL DEFAULT false;

-- A governing revision of a source becomes immutable once the source has ever been approved.
CREATE FUNCTION source_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sources cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM source_approval_decision d WHERE d.source_id = OLD.id AND d.decision <> 'REJECTED')
     AND (NEW.part_id, NEW.supplier_id, NEW.site_id, NEW.supplier_part_id, NEW.configuration, NEW.baseline_revision_id, NEW.pathway)
         IS DISTINCT FROM (OLD.part_id, OLD.supplier_id, OLD.site_id, OLD.supplier_part_id, OLD.configuration, OLD.baseline_revision_id, OLD.pathway) THEN
    RAISE EXCEPTION 'the identity of an approved source is immutable; create a new source for a new revision or site' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- supplier qualification
CREATE TABLE supplier_qualification (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               text NOT NULL UNIQUE,
  supplier_id          uuid NOT NULL REFERENCES supplier(id),
  -- NULL = supplier (parent) level; a site qualification never qualifies another site.
  site_id              uuid REFERENCES supplier_site(id),
  kind                 text NOT NULL CHECK (kind IN ('INITIAL', 'REASSESSMENT')),
  scope                text NOT NULL,
  findings             text NOT NULL,
  proposed_result      text NOT NULL CHECK (proposed_result IN ('QUALIFIED', 'CONDITIONALLY_QUALIFIED', 'REJECTED')),
  proposed_conditions  text,
  proposed_valid_until date,
  assessor_id          uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'UNDER_REVIEW' CHECK (status IN ('UNDER_REVIEW', 'DECIDED', 'WITHDRAWN')),
  decision             text CHECK (decision IN ('QUALIFIED', 'CONDITIONALLY_QUALIFIED', 'REJECTED')),
  conditions           text,
  valid_until          date,
  rationale            text,
  decided_by           uuid REFERENCES app_user(id),
  decided_at           timestamptz,
  grants_used          text[],
  version              integer NOT NULL DEFAULT 1,
  CHECK (status <> 'DECIDED' OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (decision IS DISTINCT FROM 'CONDITIONALLY_QUALIFIED' OR (conditions IS NOT NULL AND valid_until IS NOT NULL))
);
CREATE INDEX supplier_qualification_subject_idx ON supplier_qualification (supplier_id, site_id, decided_at);

CREATE FUNCTION decided_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DECIDED' OR OLD.status = 'WITHDRAWN' THEN
    RAISE EXCEPTION '% % is decided and immutable', TG_TABLE_NAME, OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_qualification_guard BEFORE UPDATE OR DELETE ON supplier_qualification
  FOR EACH ROW EXECUTE FUNCTION decided_record_guard();

CREATE TABLE supplier_restriction (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid NOT NULL REFERENCES supplier(id),
  site_id       uuid REFERENCES supplier_site(id),
  kind          text NOT NULL DEFAULT 'SUSPENDED' CHECK (kind IN ('SUSPENDED')),
  reason        text NOT NULL,
  decided_by    uuid NOT NULL REFERENCES app_user(id),
  decided_at    timestamptz NOT NULL DEFAULT now(),
  lifted_by     uuid REFERENCES app_user(id),
  lifted_at     timestamptz,
  lift_reason   text,
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL))
);
CREATE UNIQUE INDEX supplier_restriction_active_key
  ON supplier_restriction (supplier_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE lifted_at IS NULL;

CREATE FUNCTION supplier_restriction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'restrictions cannot be deleted; reinstate instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.lifted_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['lifted_by', 'lifted_at', 'lift_reason']) <> (to_jsonb(OLD) - ARRAY['lifted_by', 'lifted_at', 'lift_reason']) THEN
    RAISE EXCEPTION 'a restriction decision is immutable; only its reinstatement may be recorded once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_restriction_guard BEFORE UPDATE OR DELETE ON supplier_restriction
  FOR EACH ROW EXECUTE FUNCTION supplier_restriction_guard();

CREATE TABLE supplier_certificate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid NOT NULL REFERENCES supplier(id),
  site_id       uuid REFERENCES supplier_site(id),
  cert_type     text NOT NULL,
  cert_number   text,
  issuer        text,
  valid_until   date,
  recorded_by   uuid NOT NULL REFERENCES app_user(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- sourcing
CREATE TABLE sourcing_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                 text NOT NULL UNIQUE,
  title                  text NOT NULL,
  pathway                text NOT NULL CHECK (pathway IN ('A', 'B', 'C')),
  part_id                uuid REFERENCES company_part(id),
  proposed_part_number   text,
  description            text,
  supplier_id            uuid REFERENCES supplier(id),
  site_id                uuid REFERENCES supplier_site(id),
  supplier_part_number   text,
  configuration          text NOT NULL DEFAULT 'STANDARD',
  commercial_rationale   text,
  quantity_note          text,
  owner_id               uuid NOT NULL REFERENCES app_user(id),
  target_date            date,
  status                 text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SOURCE_CREATED', 'APPROVED', 'CANCELLED')),
  source_id              uuid REFERENCES source(id),
  created_by             uuid NOT NULL REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1,
  CHECK (part_id IS NOT NULL OR proposed_part_number IS NOT NULL)
);

-- Append-only: each (re)assessment keeps inputs, rule version and result.
CREATE TABLE risk_assessment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourcing_request_id   uuid NOT NULL REFERENCES sourcing_request(id),
  inputs                jsonb NOT NULL,
  rule_version          text NOT NULL,
  score                 integer NOT NULL,
  result                text NOT NULL CHECK (result IN ('LOW', 'MEDIUM', 'HIGH')),
  rationale             text,
  assessed_by           uuid NOT NULL REFERENCES app_user(id),
  assessed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER risk_assessment_immutable BEFORE UPDATE OR DELETE ON risk_assessment
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE evidence_requirement (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourcing_request_id   uuid NOT NULL REFERENCES sourcing_request(id),
  code                  text NOT NULL,
  title                 text NOT NULL,
  applicability         text NOT NULL CHECK (applicability IN ('REQUIRED', 'CONDITIONAL', 'NOT_APPLICABLE')),
  rationale             text NOT NULL,
  rule_version          text NOT NULL,
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SATISFIED', 'WAIVED')),
  satisfied_by          uuid REFERENCES app_user(id),
  satisfied_at          timestamptz,
  satisfaction_note     text,
  waived_by             uuid REFERENCES app_user(id),
  waived_at             timestamptz,
  waiver_reason         text,
  version               integer NOT NULL DEFAULT 1,
  UNIQUE (sourcing_request_id, code),
  CHECK (status <> 'WAIVED' OR (waived_by IS NOT NULL AND waiver_reason IS NOT NULL)),
  CHECK (status <> 'SATISFIED' OR satisfied_by IS NOT NULL)
);

-- ---------------------------------------------------------------- supplier acknowledgment
CREATE TABLE supplier_acknowledgment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             uuid NOT NULL REFERENCES source(id),
  baseline_revision_id  uuid NOT NULL REFERENCES baseline_revision(id),
  sent_via              text NOT NULL CHECK (sent_via IN ('EMAIL', 'PORTAL', 'MEETING', 'MAIL', 'OTHER')),
  sent_to               text NOT NULL,
  sent_at               timestamptz NOT NULL,
  sent_by               uuid NOT NULL REFERENCES app_user(id),
  response              text NOT NULL DEFAULT 'PENDING' CHECK (response IN ('PENDING', 'ACKNOWLEDGED', 'OBJECTED')),
  representative        text,
  responded_at          timestamptz,
  response_note         text,
  recorded_by           uuid REFERENCES app_user(id),
  recorded_at           timestamptz,
  CHECK (response = 'PENDING' OR (representative IS NOT NULL AND responded_at IS NOT NULL AND recorded_by IS NOT NULL))
);

CREATE FUNCTION acknowledgment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'acknowledgments cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.response <> 'PENDING'
     OR (NEW.source_id, NEW.baseline_revision_id, NEW.sent_via, NEW.sent_to, NEW.sent_at, NEW.sent_by)
        IS DISTINCT FROM (OLD.source_id, OLD.baseline_revision_id, OLD.sent_via, OLD.sent_to, OLD.sent_at, OLD.sent_by) THEN
    RAISE EXCEPTION 'a supplier response is recorded once against the exact revision sent' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_acknowledgment_guard BEFORE UPDATE OR DELETE ON supplier_acknowledgment
  FOR EACH ROW EXECUTE FUNCTION acknowledgment_guard();

-- ---------------------------------------------------------------- first article / validation samples
CREATE TABLE fai_sample (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE,
  source_id             uuid NOT NULL REFERENCES source(id),
  sequence              integer NOT NULL,
  sample_type           text NOT NULL CHECK (sample_type IN ('INITIAL_FAI', 'RESUBMITTED_FAI', 'PROTOTYPE', 'PRODUCTION_REPRESENTATIVE')),
  baseline_revision_id  uuid NOT NULL REFERENCES baseline_revision(id),
  previous_fai_id       uuid REFERENCES fai_sample(id),
  corrective_rationale  text,
  lot_number            text,
  serial_numbers        text,
  received_date         date NOT NULL,
  description           text,
  recorded_by           uuid NOT NULL REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DECIDED', 'WITHDRAWN')),
  decision              text CHECK (decision IN ('ACCEPTED', 'CONDITIONAL', 'REJECTED')),
  conditions            text,
  defects               text,
  rationale             text,
  decided_by            uuid REFERENCES app_user(id),
  decided_at            timestamptz,
  grants_used           text[],
  version               integer NOT NULL DEFAULT 1,
  UNIQUE (source_id, sequence),
  CHECK (status <> 'DECIDED' OR (decision IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (decision IS DISTINCT FROM 'CONDITIONAL' OR conditions IS NOT NULL),
  CHECK (decision IS DISTINCT FROM 'REJECTED' OR defects IS NOT NULL)
);
CREATE TRIGGER fai_sample_guard BEFORE UPDATE OR DELETE ON fai_sample
  FOR EACH ROW EXECUTE FUNCTION decided_record_guard();

CREATE TABLE fai_result (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fai_id         uuid NOT NULL REFERENCES fai_sample(id),
  char_key       text NOT NULL,
  char_name      text NOT NULL,
  unit           text,
  lower_limit    numeric,
  upper_limit    numeric,
  value_text     text,
  value_numeric  numeric,
  visual_result  text CHECK (visual_result IN ('CONFORMS', 'DOES_NOT_CONFORM')),
  evaluation     text NOT NULL CHECK (evaluation IN ('WITHIN', 'OUTSIDE', 'NO_LIMIT', 'CONFORMS', 'DOES_NOT_CONFORM')),
  note           text,
  recorded_by    uuid NOT NULL REFERENCES app_user(id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fai_id, char_key)
);

CREATE FUNCTION fai_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM fai_sample WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.fai_id ELSE OLD.fai_id END;
  IF st <> 'OPEN' THEN
    RAISE EXCEPTION 'results of a decided first article are frozen' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fai_result_guard BEFORE INSERT OR UPDATE OR DELETE ON fai_result
  FOR EACH ROW EXECUTE FUNCTION fai_result_guard();

-- ---------------------------------------------------------------- exact source approval
CREATE TABLE source_approval_decision (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  source_id        uuid NOT NULL REFERENCES source(id),
  decision         text NOT NULL CHECK (decision IN ('APPROVED', 'APPROVED_CONDITIONAL', 'REJECTED')),
  scope            text NOT NULL,
  conditions       text,
  valid_until      date,
  rationale        text NOT NULL,
  approver_id      uuid NOT NULL REFERENCES app_user(id),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  grants_used      text[] NOT NULL,
  gate_results     jsonb NOT NULL,
  manifest         jsonb NOT NULL,
  manifest_sha256  text NOT NULL,
  CHECK (decision <> 'APPROVED_CONDITIONAL' OR conditions IS NOT NULL)
);
CREATE INDEX source_approval_decision_source_idx ON source_approval_decision (source_id, decided_at);
CREATE TRIGGER source_approval_decision_immutable BEFORE UPDATE OR DELETE ON source_approval_decision
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TRIGGER source_identity_guard BEFORE UPDATE OR DELETE ON source
  FOR EACH ROW EXECUTE FUNCTION source_identity_guard();

-- ---------------------------------------------------------------- unified work queue
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN (
  'INSPECTION_ASSIGNED', 'INSPECTION_REVIEW', 'CONCERN_TRIAGE', 'CONCERN_FOLLOW_UP',
  'QUALIFICATION_DECISION', 'BASELINE_RELEASE', 'FAI_DECISION', 'SOURCE_APPROVAL', 'SUPPLIER_RESPONSE', 'SOURCING_REQUEST'));
