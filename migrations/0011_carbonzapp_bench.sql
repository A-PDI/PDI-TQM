-- CarbonZapp test bench (owner decisions, 22 Oct 2026). Bench results are pulled from the
-- CarbonZapp cloud API with "Sync now" by administrators, stored as immutable injector tests
-- (one per injector per bench slot) under a bench_import that keeps the fetched reports, and
-- can be selected to start a PDI-IQI-012 incoming inspection that carries them read-only.

-- Owner decision: syncing and starting inspections from bench results is for administrators.
-- The capability row is loaded again (with its description) by the reference data after migrations.
INSERT INTO capability (code, description, sensitive)
VALUES ('injector.bench_sync', 'Sync CarbonZapp bench results and start inspections from them', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO authority_grant (user_id, capability_code, reason)
SELECT DISTINCT g.user_id, 'injector.bench_sync', 'Bench sync is for administrators (owner decision 22 Oct 2026)'
  FROM authority_grant g JOIN app_user u ON u.id = g.user_id
 WHERE g.capability_code = 'admin.users' AND g.revoked_at IS NULL AND u.active
   AND NOT EXISTS (SELECT 1 FROM authority_grant x WHERE x.user_id = g.user_id AND x.capability_code = 'injector.bench_sync' AND x.revoked_at IS NULL);

INSERT INTO audit_event (action, outcome, entity_type, summary)
SELECT 'admin.grant', 'SUCCESS', 'capability', format('injector.bench_sync granted to %s active administrator(s): bench sync is for administrators', count(*))
  FROM authority_grant WHERE capability_code = 'injector.bench_sync' AND revoked_at IS NULL;

-- Bench classification of a whole test: PASS / FAIL against the bench's green band, DNF when the
-- run was interrupted, UNKNOWN when nothing could be scored. NULL for CSV and manual tests.
ALTER TABLE injector_test
  ADD COLUMN bench_outcome text CHECK (bench_outcome IN ('PASS', 'FAIL', 'DNF', 'UNKNOWN')),
  ADD COLUMN bench_report_id text,
  ADD COLUMN bench_slot integer,
  ADD CONSTRAINT injector_test_bench_identity CHECK ((bench_report_id IS NULL) = (bench_slot IS NULL));
CREATE UNIQUE INDEX injector_test_bench_slot_idx ON injector_test (bench_report_id, bench_slot) WHERE bench_report_id IS NOT NULL;
CREATE INDEX injector_test_bench_outcome_idx ON injector_test (tested_at DESC) WHERE bench_outcome IS NOT NULL;

-- Per measurement: the bench's green band and specification text, the step outcome and any bench note.
ALTER TABLE injector_test_result
  ADD COLUMN position integer,
  ADD COLUMN bench_spec text,
  ADD COLUMN bench_lower numeric,
  ADD COLUMN bench_upper numeric,
  ADD COLUMN bench_outcome text CHECK (bench_outcome IN ('PASS', 'FAIL', 'DNF', 'UNKNOWN')),
  ADD COLUMN bench_note text,
  ADD COLUMN bench_conditions text;

-- Bench results whose part number does not yet match a PDI part (part number or alias). They are
-- kept here and imported by a later sync once the alias exists; nothing here is a test record.
CREATE TABLE bench_pending (
  source_key     text PRIMARY KEY,
  part_number    text NOT NULL,
  serial_number  text NOT NULL,
  tested_at      timestamptz NOT NULL,
  reason         text NOT NULL,
  payload        jsonb NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bench_pending_part_idx ON bench_pending (upper(part_number));

-- The bench test behind each item of an inspection started from bench results (read-only results).
CREATE TABLE inspection_bench_test (
  inspection_id  uuid NOT NULL REFERENCES inspection(id),
  unit_index     integer NOT NULL CHECK (unit_index BETWEEN 1 AND 100),
  test_id        uuid NOT NULL REFERENCES injector_test(id),
  linked_by      uuid NOT NULL REFERENCES app_user(id),
  linked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inspection_id, unit_index),
  UNIQUE (inspection_id, test_id)
);
CREATE INDEX inspection_bench_test_test_idx ON inspection_bench_test (test_id);
CREATE TRIGGER inspection_bench_test_immutable BEFORE UPDATE OR DELETE ON inspection_bench_test
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
