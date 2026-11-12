-- One approval path per module event (owner request, 11 Nov 2026).
-- Additive only: existing controlled records, signatures and renditions are not changed. Records
-- created before this migration keep event_bound = false and remain exactly as recorded.

-- A record opened by a module event (inspection, NCR, concession, SCAR, first article, source
-- approval request, change, sourcing request). Its deciding approval is signed by the module's own
-- decision; facts the module holds are carried onto the form rather than retyped.
ALTER TABLE controlled_record ADD COLUMN event_bound boolean NOT NULL DEFAULT false;

-- At most one open record of a type per module event. Completed and void records stay on file, so a
-- reopened event (a SCAR reopened by recurrence, a source re-approval) opens a new record.
CREATE UNIQUE INDEX controlled_record_open_event_idx ON controlled_record (type_code, entity_type, entity_id)
  WHERE event_bound AND status IN ('DRAFT', 'SUBMITTED');

-- The module action that executed an approval block (e.g. concession.decide), so the signature and the
-- module decision are one act. NULL for signatures given on the controlled record itself.
ALTER TABLE controlled_record_signature ADD COLUMN module_action text;

-- event_bound is part of the record's identity once set.
CREATE OR REPLACE FUNCTION controlled_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled record % cannot be deleted', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF NEW.number <> OLD.number OR NEW.type_code <> OLD.type_code OR NEW.category <> OLD.category
     OR NEW.document_id <> OLD.document_id OR NEW.revision_id <> OLD.revision_id
     OR NEW.entity_type <> OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at
     OR NEW.event_bound <> OLD.event_bound THEN
    RAISE EXCEPTION 'the identity and revision binding of controlled record % are immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('COMPLETED', 'VOID') THEN
    RAISE EXCEPTION 'controlled record % is % and cannot change', OLD.number, lower(OLD.status) USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.data IS DISTINCT FROM OLD.data THEN
    RAISE EXCEPTION 'controlled record % is submitted for approval; return it before editing', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
