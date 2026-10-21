-- Stage 4: serialized injectors with idempotent bench-file imports, manual tests, repair
-- cases/actions/quick measurements, retest attribution, shipment evaluations, and
-- auditable management report editions.

CREATE TABLE injector (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id            uuid NOT NULL REFERENCES company_part(id),
  serial_number      text NOT NULL,
  normalized_serial  text NOT NULL,
  oe_part_number     text,
  notes              text,
  is_synthetic       boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (part_id, normalized_serial)
);
CREATE INDEX injector_serial_idx ON injector (normalized_serial);
CREATE TRIGGER injector_no_delete BEFORE DELETE ON injector FOR EACH ROW EXECUTE FUNCTION no_delete();

-- One uploaded bench file. Its original bytes are an IMPORT file object; the outcome of every
-- row is kept in `report` so a re-import explains exactly what was added, skipped or excluded.
CREATE TABLE bench_import (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  file_id          uuid NOT NULL REFERENCES file_object(id),
  file_sha256      text NOT NULL,
  adapter          text NOT NULL,
  status           text NOT NULL CHECK (status IN ('COMPLETED', 'DUPLICATE_FILE')),
  tests_total      integer NOT NULL,
  tests_added      integer NOT NULL,
  tests_duplicate  integer NOT NULL,
  tests_conflict   integer NOT NULL,
  tests_excluded   integer NOT NULL,
  injectors_added  integer NOT NULL,
  report           jsonb NOT NULL,
  imported_by      uuid NOT NULL REFERENCES app_user(id),
  imported_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bench_import_sha_idx ON bench_import (file_sha256);
CREATE TRIGGER bench_import_immutable BEFORE UPDATE OR DELETE ON bench_import FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE repair_case (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  injector_id   uuid NOT NULL REFERENCES injector(id),
  problem       text NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opened_by     uuid NOT NULL REFERENCES app_user(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid REFERENCES app_user(id),
  closed_at     timestamptz,
  closure_note  text,
  version       integer NOT NULL DEFAULT 1,
  CHECK (status = 'OPEN' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND closure_note IS NOT NULL))
);
CREATE TRIGGER repair_case_guard BEFORE UPDATE OR DELETE ON repair_case
  FOR EACH ROW EXECUTE FUNCTION final_status_guard('CLOSED');

CREATE TABLE repair_action (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES repair_case(id),
  action_type         text NOT NULL CHECK (action_type IN ('ADJUSTMENT', 'COMPONENT_REPLACEMENT', 'CLEANING', 'OTHER')),
  description         text NOT NULL,
  component_replaced  text,
  technician_id       uuid NOT NULL REFERENCES app_user(id),
  performed_at        timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (action_type <> 'COMPONENT_REPLACEMENT' OR component_replaced IS NOT NULL)
);
CREATE INDEX repair_action_case_idx ON repair_action (case_id);
CREATE TRIGGER repair_action_immutable BEFORE UPDATE OR DELETE ON repair_action FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Quick workshop measurements (shim, preload, stroke, lift…) exactly as entered; no limits implied.
CREATE TABLE repair_measurement (
  action_id   uuid NOT NULL REFERENCES repair_action(id),
  name        text NOT NULL,
  value_text  text NOT NULL,
  value       numeric,
  unit        text,
  PRIMARY KEY (action_id, name)
);
CREATE TRIGGER repair_measurement_immutable BEFORE UPDATE OR DELETE ON repair_measurement FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE injector_test (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  injector_id           uuid NOT NULL REFERENCES injector(id),
  -- Idempotency key: machine + serial + test time + sequence. A repeated key never overwrites.
  source_key            text NOT NULL UNIQUE,
  content_sha256        text NOT NULL,
  origin                text NOT NULL CHECK (origin IN ('IMPORT', 'MANUAL')),
  -- Deferred: the import record (with final counts) is written last in the same transaction.
  import_id             uuid REFERENCES bench_import(id) DEFERRABLE INITIALLY DEFERRED,
  machine_id            text NOT NULL,
  test_plan             text NOT NULL,
  tested_at             timestamptz NOT NULL,
  operator              text,
  machine_verdict       text NOT NULL CHECK (machine_verdict IN ('PASS', 'FAIL', 'NOT_REPORTED')),
  -- PDI evaluation frozen against the criteria released when the test was recorded.
  pdi_evaluation        text NOT NULL CHECK (pdi_evaluation IN ('PASS', 'FAIL', 'NO_CRITERIA', 'PARTIAL_CRITERIA')),
  criteria_revision_id  uuid REFERENCES baseline_revision(id),
  repair_action_id      uuid REFERENCES repair_action(id),
  raw                   jsonb NOT NULL,
  note                  text,
  recorded_by           uuid NOT NULL REFERENCES app_user(id),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'IMPORT') = (import_id IS NOT NULL))
);
CREATE INDEX injector_test_injector_idx ON injector_test (injector_id, tested_at);

-- Test records are immutable; only a retest attribution may be recorded once afterwards.
CREATE FUNCTION injector_test_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'injector tests cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.repair_action_id IS NOT NULL
     OR (to_jsonb(NEW) - 'repair_action_id') <> (to_jsonb(OLD) - 'repair_action_id') THEN
    RAISE EXCEPTION 'injector test data is immutable; only a retest attribution may be added once' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER injector_test_guard BEFORE UPDATE OR DELETE ON injector_test FOR EACH ROW EXECUTE FUNCTION injector_test_guard();

CREATE TABLE injector_test_result (
  test_id          uuid NOT NULL REFERENCES injector_test(id),
  condition        text NOT NULL,
  parameter        text NOT NULL,
  unit             text,
  value_text       text NOT NULL,
  value            numeric,
  machine_verdict  text CHECK (machine_verdict IN ('PASS', 'FAIL')),
  lower_limit      numeric,
  upper_limit      numeric,
  pdi_evaluation   text NOT NULL CHECK (pdi_evaluation IN ('WITHIN', 'OUTSIDE', 'NO_LIMIT')),
  PRIMARY KEY (test_id, condition, parameter)
);
CREATE TRIGGER injector_test_result_immutable BEFORE UPDATE OR DELETE ON injector_test_result FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- A frozen evaluation of selected injectors before shipment (not a material release).
CREATE TABLE shipment_evaluation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  reference     text NOT NULL,
  note          text,
  conclusion    text NOT NULL CHECK (conclusion IN ('ALL_PASS', 'EXCEPTIONS')),
  evaluated_by  uuid NOT NULL REFERENCES app_user(id),
  evaluated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER shipment_evaluation_immutable BEFORE UPDATE OR DELETE ON shipment_evaluation FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE TABLE shipment_evaluation_item (
  evaluation_id  uuid NOT NULL REFERENCES shipment_evaluation(id),
  position       integer NOT NULL,
  injector_id    uuid NOT NULL REFERENCES injector(id),
  test_id        uuid REFERENCES injector_test(id),
  result         text NOT NULL CHECK (result IN ('PASS', 'FAIL', 'NO_CRITERIA', 'NOT_TESTED')),
  basis          text NOT NULL,
  PRIMARY KEY (evaluation_id, position),
  UNIQUE (evaluation_id, injector_id)
);
CREATE TRIGGER shipment_evaluation_item_immutable BEFORE UPDATE OR DELETE ON shipment_evaluation_item FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Issued management report editions (period, filters and metric definitions are frozen in the snapshot).
CREATE TABLE management_report (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               text NOT NULL UNIQUE,
  period_from          date NOT NULL,
  period_to            date NOT NULL,
  definitions_version  text NOT NULL,
  issued_by            uuid NOT NULL REFERENCES app_user(id),
  issued_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE TRIGGER management_report_immutable BEFORE UPDATE OR DELETE ON management_report FOR EACH ROW EXECUTE FUNCTION immutable_row();
