-- Cylinder head Stage 2 (owner decisions, 22 Oct 2026). Heads received in Stage 1 condition are
-- inspected and stocked; some are later converted to a Stage 2 product (a different part number) by
-- cutting fire ring grooves and installing the wire. Stage 2 is recorded per head as its own dated
-- record linked to the completed Stage 1 inspection, which stays frozen. It has its own entries,
-- review (same rules as Stage 1) and an addendum PDF.

CREATE TABLE inspection_stage (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE,
  inspection_id         uuid NOT NULL REFERENCES inspection(id),
  unit_index            integer NOT NULL CHECK (unit_index BETWEEN 1 AND 100),
  stage                 text NOT NULL CHECK (stage IN ('STAGE_2')),
  section_snapshot      jsonb NOT NULL,
  serial_number         text NOT NULL,
  stage_part_id         uuid NOT NULL REFERENCES company_part(id),
  stage_part_number     text NOT NULL,
  baseline_revision_id  uuid REFERENCES baseline_revision(id),
  baseline_snapshot     jsonb,
  performed_on          date NOT NULL,
  inspector_id          uuid NOT NULL REFERENCES app_user(id),
  created_by            uuid NOT NULL REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'READY_FOR_REVIEW', 'COMPLETED')),
  outcome               text CHECK (outcome IN ('PASS', 'FAIL', 'ACCEPTED')),
  review_reasons        jsonb,
  submitted_at          timestamptz,
  completed_by          uuid REFERENCES app_user(id),
  completed_at          timestamptz,
  version               integer NOT NULL DEFAULT 1,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, unit_index, stage),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE FUNCTION inspection_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stage record % cannot be deleted', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed stage record % is frozen', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF NEW.number <> OLD.number OR NEW.inspection_id <> OLD.inspection_id OR NEW.unit_index <> OLD.unit_index OR NEW.stage <> OLD.stage
     OR NEW.section_snapshot <> OLD.section_snapshot OR NEW.serial_number <> OLD.serial_number OR NEW.stage_part_id <> OLD.stage_part_id
     OR NEW.baseline_revision_id IS DISTINCT FROM OLD.baseline_revision_id OR NEW.baseline_snapshot IS DISTINCT FROM OLD.baseline_snapshot
     OR NEW.inspector_id <> OLD.inspector_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of stage record % is immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_stage_guard BEFORE UPDATE OR DELETE ON inspection_stage
  FOR EACH ROW EXECUTE FUNCTION inspection_stage_guard();

CREATE TABLE inspection_stage_response (
  stage_id    uuid NOT NULL REFERENCES inspection_stage(id),
  row_key     text NOT NULL,
  status      text CHECK (status IN ('P', 'F', 'A', 'N')),
  note        text,
  updated_by  uuid NOT NULL REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, row_key)
);

CREATE TABLE inspection_stage_measurement (
  stage_id       uuid NOT NULL REFERENCES inspection_stage(id),
  row_key        text NOT NULL,
  reading_key    text NOT NULL,
  value_text     text NOT NULL,
  value_numeric  numeric NOT NULL,
  decimals       integer,
  unit           text,
  updated_by     uuid NOT NULL REFERENCES app_user(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, row_key, reading_key)
);

-- Entries change only while the stage record is open; submitted and completed entries are frozen.
CREATE FUNCTION inspection_stage_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM inspection_stage WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.stage_id ELSE NEW.stage_id END;
  IF st IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'stage entries are locked while the stage record is %', coalesce(st, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_stage_response_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_stage_response
  FOR EACH ROW EXECUTE FUNCTION inspection_stage_entry_guard();
CREATE TRIGGER inspection_stage_measurement_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_stage_measurement
  FOR EACH ROW EXECUTE FUNCTION inspection_stage_entry_guard();

CREATE TABLE inspection_stage_review (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id     uuid NOT NULL REFERENCES inspection_stage(id),
  decision     text NOT NULL CHECK (decision IN ('CONFIRMED', 'RETURNED')),
  reviewer_id  uuid NOT NULL REFERENCES app_user(id),
  reviewed_at  timestamptz NOT NULL DEFAULT now(),
  reasons      jsonb NOT NULL,
  comment      text,
  grants_used  text[] NOT NULL
);
CREATE TRIGGER inspection_stage_review_immutable BEFORE UPDATE OR DELETE ON inspection_stage_review
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
