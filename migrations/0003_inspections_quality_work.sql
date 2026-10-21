-- Receiving inspections with frozen form/baseline snapshots, per-unit responses and
-- measurements, amendments, independent review, report snapshots/renditions,
-- evidence links, quick quality concerns and the unified work queue.

CREATE TABLE inspection (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                 text NOT NULL UNIQUE,
  form_revision_id       uuid NOT NULL REFERENCES form_revision(id),
  form_snapshot          jsonb NOT NULL,
  form_snapshot_sha256   text NOT NULL,
  baseline_revision_id   uuid REFERENCES baseline_revision(id),
  baseline_snapshot      jsonb,
  part_id                uuid REFERENCES company_part(id),
  part_number            text NOT NULL,
  part_description       text NOT NULL,
  source_id              uuid REFERENCES source(id),
  supplier_id            uuid REFERENCES supplier(id),
  site_id                uuid REFERENCES supplier_site(id),
  source_state_at_start  text NOT NULL,
  po_number              text,
  date_received          date NOT NULL,
  lot_number             text,
  lot_size               integer CHECK (lot_size IS NULL OR lot_size > 0),
  sampling_note          text,
  unit_count             integer NOT NULL CHECK (unit_count BETWEEN 1 AND 100),
  inspector_id           uuid NOT NULL REFERENCES app_user(id),
  created_by             uuid NOT NULL REFERENCES app_user(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  status                 text NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'PARTIAL', 'READY_FOR_REVIEW', 'COMPLETED', 'VOID')),
  outcome                text CHECK (outcome IN ('PASS', 'FAIL', 'ACCEPTED')),
  review_reasons         jsonb,
  submitted_by           uuid REFERENCES app_user(id),
  submitted_at           timestamptz,
  completed_by           uuid REFERENCES app_user(id),
  completed_at           timestamptz,
  amendment_count        integer NOT NULL DEFAULT 0,
  version                integer NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'COMPLETED' OR (outcome IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX inspection_created_idx ON inspection (created_at DESC);
CREATE INDEX inspection_status_idx ON inspection (status);
CREATE INDEX inspection_part_idx ON inspection (part_id);
CREATE INDEX inspection_inspector_idx ON inspection (inspector_id);

-- Completed inspections are frozen: only amendment bookkeeping may change.
CREATE FUNCTION inspection_freeze_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inspections cannot be deleted; void instead' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'COMPLETED' AND
     (to_jsonb(NEW) - ARRAY['amendment_count', 'version', 'updated_at'])
       <> (to_jsonb(OLD) - ARRAY['amendment_count', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'completed inspection % is frozen', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF OLD.form_snapshot IS DISTINCT FROM NEW.form_snapshot
     OR OLD.form_snapshot_sha256 IS DISTINCT FROM NEW.form_snapshot_sha256
     OR OLD.baseline_snapshot IS DISTINCT FROM NEW.baseline_snapshot
     OR OLD.form_revision_id IS DISTINCT FROM NEW.form_revision_id THEN
    RAISE EXCEPTION 'inspection form and baseline snapshots are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inspection_freeze_guard BEFORE UPDATE OR DELETE ON inspection
  FOR EACH ROW EXECUTE FUNCTION inspection_freeze_guard();

CREATE TABLE inspection_unit (
  inspection_id     uuid NOT NULL REFERENCES inspection(id),
  unit_index        integer NOT NULL CHECK (unit_index BETWEEN 1 AND 100),
  serial_number     text,
  disposition_note  text,
  PRIMARY KEY (inspection_id, unit_index)
);

CREATE TABLE inspection_section_activation (
  inspection_id  uuid NOT NULL REFERENCES inspection(id),
  unit_index     integer NOT NULL,
  section_key    text NOT NULL,
  activated_by   uuid NOT NULL REFERENCES app_user(id),
  activated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inspection_id, unit_index, section_key)
);

CREATE TABLE inspection_amendment (
  inspection_id  uuid NOT NULL REFERENCES inspection(id),
  amendment_no   integer NOT NULL CHECK (amendment_no > 0),
  reason         text NOT NULL,
  resulting_outcome text NOT NULL CHECK (resulting_outcome IN ('PASS', 'FAIL', 'ACCEPTED')),
  amended_by     uuid NOT NULL REFERENCES app_user(id),
  amended_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inspection_id, amendment_no)
);

-- unit_index 0 = inspection-scope (shared receiving section); 1..N = inspected unit.
-- amendment_no 0 = original entry; >0 = attributable correction layered over the original.
CREATE TABLE inspection_response (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id  uuid NOT NULL REFERENCES inspection(id),
  unit_index     integer NOT NULL CHECK (unit_index BETWEEN 0 AND 100),
  section_key    text NOT NULL,
  row_key        text NOT NULL,
  status         text CHECK (status IN ('P', 'F', 'A', 'N')),
  note           text,
  amendment_no   integer NOT NULL DEFAULT 0,
  updated_by     uuid NOT NULL REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, unit_index, section_key, row_key, amendment_no)
);

CREATE TABLE inspection_measurement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id  uuid NOT NULL REFERENCES inspection(id),
  unit_index     integer NOT NULL CHECK (unit_index BETWEEN 0 AND 100),
  section_key    text NOT NULL,
  row_key        text NOT NULL,
  reading_key    text NOT NULL,
  value_text     text,
  value_numeric  numeric,
  decimals       integer,
  unit           text,
  amendment_no   integer NOT NULL DEFAULT 0,
  updated_by     uuid NOT NULL REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, unit_index, section_key, row_key, reading_key, amendment_no),
  CHECK ((value_text IS NULL) = (value_numeric IS NULL))
);

-- Entry rows are editable only while the inspection is DRAFT/PARTIAL; after submission
-- the original layer is frozen and corrections are appended as amendment layers.
CREATE FUNCTION inspection_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  insp_status text;
  row_amendment integer;
  insp_id uuid;
BEGIN
  insp_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
  row_amendment := CASE WHEN TG_OP = 'DELETE' THEN OLD.amendment_no ELSE NEW.amendment_no END;
  SELECT status INTO insp_status FROM inspection WHERE id = insp_id;
  IF insp_status IN ('DRAFT', 'PARTIAL') THEN
    IF row_amendment <> 0 THEN
      RAISE EXCEPTION 'amendments apply only to completed inspections' USING ERRCODE = 'P0001';
    END IF;
  ELSIF insp_status = 'COMPLETED' THEN
    IF TG_OP <> 'INSERT' OR row_amendment = 0 THEN
      RAISE EXCEPTION 'completed inspection entries are frozen; record an amendment' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'inspection entries are locked while status is %', insp_status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inspection_response_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_response
  FOR EACH ROW EXECUTE FUNCTION inspection_entry_guard();
CREATE TRIGGER inspection_measurement_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_measurement
  FOR EACH ROW EXECUTE FUNCTION inspection_entry_guard();

CREATE FUNCTION inspection_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  insp_status text;
BEGIN
  SELECT status INTO insp_status FROM inspection
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
  IF TG_OP <> 'INSERT' AND insp_status NOT IN ('DRAFT', 'PARTIAL') THEN
    RAISE EXCEPTION 'inspection units are locked while status is %', insp_status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inspection_unit_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_unit
  FOR EACH ROW EXECUTE FUNCTION inspection_unit_guard();

CREATE TABLE inspection_review (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id  uuid NOT NULL REFERENCES inspection(id),
  decision       text NOT NULL CHECK (decision IN ('CONFIRMED', 'RETURNED')),
  reviewer_id    uuid NOT NULL REFERENCES app_user(id),
  reviewed_at    timestamptz NOT NULL DEFAULT now(),
  reasons        jsonb NOT NULL,
  comment        text,
  grants_used    text[] NOT NULL
);

-- Frozen structured content from which each report edition is rendered.
CREATE TABLE report_snapshot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  edition       integer NOT NULL CHECK (edition > 0),
  snapshot      jsonb NOT NULL,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, edition)
);

CREATE TABLE report_rendition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id   uuid NOT NULL UNIQUE REFERENCES report_snapshot(id),
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  edition       integer NOT NULL,
  file_id       uuid NOT NULL REFERENCES file_object(id),
  sha256        text NOT NULL,
  page_count    integer NOT NULL,
  rendered_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, edition)
);

CREATE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER report_snapshot_immutable BEFORE UPDATE OR DELETE ON report_snapshot
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER report_rendition_immutable BEFORE UPDATE OR DELETE ON report_rendition
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER inspection_review_immutable BEFORE UPDATE OR DELETE ON inspection_review
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER inspection_amendment_immutable BEFORE UPDATE OR DELETE ON inspection_amendment
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Links a single stored file to the records it evidences (no cloned blobs).
CREATE TABLE evidence_link (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id        uuid NOT NULL REFERENCES file_object(id),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  inspection_id  uuid REFERENCES inspection(id),
  unit_index     integer,
  section_key    text,
  row_key        text,
  caption        text,
  linked_by      uuid NOT NULL REFERENCES app_user(id),
  linked_at      timestamptz NOT NULL DEFAULT now(),
  unlinked_at    timestamptz,
  unlinked_by    uuid REFERENCES app_user(id),
  unlink_reason  text
);
CREATE INDEX evidence_link_entity_idx ON evidence_link (entity_type, entity_id);
CREATE INDEX evidence_link_inspection_idx ON evidence_link (inspection_id, unit_index, section_key, row_key);

CREATE TABLE quality_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  title            text NOT NULL,
  description      text NOT NULL,
  origin_type      text NOT NULL CHECK (origin_type IN ('INSPECTION', 'AD_HOC', 'SUPPLIER_COMMUNICATION', 'TEST', 'CUSTOMER')),
  inspection_id    uuid REFERENCES inspection(id),
  unit_index       integer,
  section_key      text,
  row_key          text,
  characteristic   text,
  expected         text,
  actual           text,
  part_id          uuid REFERENCES company_part(id),
  supplier_id      uuid REFERENCES supplier(id),
  site_id          uuid REFERENCES supplier_site(id),
  source_id        uuid REFERENCES source(id),
  po_number        text,
  lot_number       text,
  serial_number    text,
  reported_by      uuid NOT NULL REFERENCES app_user(id),
  reported_at      timestamptz NOT NULL DEFAULT now(),
  owner_id         uuid REFERENCES app_user(id),
  severity         text CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status           text NOT NULL DEFAULT 'CAPTURED'
                   CHECK (status IN ('CAPTURED', 'TRIAGED', 'CONFIRMED_NCR', 'NONCONFIRMED', 'INFORMATIONAL')),
  triaged_by       uuid REFERENCES app_user(id),
  triaged_at       timestamptz,
  triage_reason    text,
  version          integer NOT NULL DEFAULT 1
);
CREATE INDEX quality_event_status_idx ON quality_event (status);
CREATE INDEX quality_event_inspection_idx ON quality_event (inspection_id);

CREATE TABLE work_item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('INSPECTION_ASSIGNED', 'INSPECTION_REVIEW', 'CONCERN_TRIAGE', 'CONCERN_FOLLOW_UP')),
  title                text NOT NULL,
  subject_type         text NOT NULL,
  subject_id           uuid NOT NULL,
  assignee_id          uuid REFERENCES app_user(id),
  -- Unassigned items are visible to holders of this capability.
  required_capability  text REFERENCES capability(code),
  due_at               timestamptz,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  closed_by            uuid REFERENCES app_user(id),
  closed_reason        text
);
CREATE INDEX work_item_open_idx ON work_item (status, assignee_id);
CREATE UNIQUE INDEX work_item_open_subject_key ON work_item (kind, subject_type, subject_id) WHERE status = 'OPEN';
