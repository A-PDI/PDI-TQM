-- Controlled documents drive the work (owner request, 11 Nov 2026).
-- Additive only: no existing table or row is changed. Generated PDFs reuse report_snapshot /
-- report_rendition (subject_type 'CONTROLLED_RECORD'); attached files reuse evidence_link
-- (entity_type 'CONTROLLED_RECORD').

-- Data-entry definition derived from one released revision of a controlled PDF (its AcroForm field
-- tree and page text). Derived once, never edited: a new revision gets its own row.
CREATE TABLE controlled_template (
  revision_id    uuid PRIMARY KEY REFERENCES controlled_document_revision(id),
  deriver        text NOT NULL,
  interactive    boolean NOT NULL,
  schema         jsonb NOT NULL,
  schema_sha256  text NOT NULL,
  derived_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER controlled_template_immutable BEFORE UPDATE OR DELETE ON controlled_template
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- One controlled record (a filled form, or an attached external document with its signatures),
-- bound at creation to the released revision then in force.
CREATE TABLE controlled_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  type_code        text NOT NULL,
  category         text NOT NULL CHECK (category IN ('FORM', 'ATTACHMENT')),
  document_id      uuid NOT NULL REFERENCES controlled_document(id),
  revision_id      uuid NOT NULL REFERENCES controlled_document_revision(id),
  entity_type      text NOT NULL,
  entity_id        uuid,
  entity_label     text NOT NULL,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'COMPLETED', 'VOID')),
  data             jsonb NOT NULL DEFAULT '{"fields": {}, "schedules": {}}'::jsonb,
  data_sha256      text,
  record_revision  integer NOT NULL DEFAULT 1,
  cycle            integer NOT NULL DEFAULT 1,
  prepared_by      uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  submitted_by     uuid REFERENCES app_user(id),
  submitted_at     timestamptz,
  completed_at     timestamptz,
  voided_by        uuid REFERENCES app_user(id),
  voided_at        timestamptz,
  void_reason      text,
  version          integer NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((entity_type = 'SYSTEM') = (entity_id IS NULL)),
  CHECK (status <> 'SUBMITTED' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND data_sha256 IS NOT NULL)),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CHECK (status <> 'VOID' OR (voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX controlled_record_entity_idx ON controlled_record (entity_type, entity_id);
CREATE INDEX controlled_record_type_idx ON controlled_record (type_code, status);

CREATE OR REPLACE FUNCTION controlled_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled record % cannot be deleted', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF NEW.number <> OLD.number OR NEW.type_code <> OLD.type_code OR NEW.category <> OLD.category
     OR NEW.document_id <> OLD.document_id OR NEW.revision_id <> OLD.revision_id
     OR NEW.entity_type <> OLD.entity_type OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at THEN
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
CREATE TRIGGER controlled_record_guard BEFORE UPDATE OR DELETE ON controlled_record
  FOR EACH ROW EXECUTE FUNCTION controlled_record_guard();

-- The exact revisions a record is bound to: its base form and every sheet it may continue on.
CREATE TABLE controlled_record_binding (
  record_id     uuid NOT NULL REFERENCES controlled_record(id),
  document_id   uuid NOT NULL REFERENCES controlled_document(id),
  revision_id   uuid NOT NULL REFERENCES controlled_document_revision(id),
  role          text NOT NULL CHECK (role IN ('BASE', 'CONTINUATION', 'EVIDENCE', 'NARRATIVE')),
  schedule_key  text,
  PRIMARY KEY (record_id, document_id),
  CHECK ((role = 'CONTINUATION') = (schedule_key IS NOT NULL))
);
CREATE TRIGGER controlled_record_binding_immutable BEFORE UPDATE OR DELETE ON controlled_record_binding
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Approvals on FORM records (approver blocks of the template) and the required acknowledgments or
-- signatures on ATTACHMENT records. INTERNAL: signed in TQM by the signer. EXTERNAL: attested from
-- the executed document by the person recording it. A returned record starts a new cycle; earlier
-- signatures stay on record.
CREATE TABLE controlled_record_signature (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     uuid NOT NULL REFERENCES controlled_record(id),
  cycle         integer NOT NULL,
  role_key      text NOT NULL,
  role_label    text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('INTERNAL', 'EXTERNAL', 'NOT_REQUIRED')),
  signer_id     uuid NOT NULL REFERENCES app_user(id),
  signer_name   text NOT NULL,
  signer_title  text,
  signed_on     date NOT NULL,
  decision      text,
  statement     text,
  reference     text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_sha256   text NOT NULL,
  grants_used   text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, cycle, role_key)
);
CREATE TRIGGER controlled_record_signature_immutable BEFORE UPDATE OR DELETE ON controlled_record_signature
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Result of checking a generated PDF against the approved template revisions it was built from.
CREATE TABLE controlled_output_validation (
  rendition_id  uuid PRIMARY KEY REFERENCES report_rendition(id),
  ok            boolean NOT NULL,
  result        jsonb NOT NULL,
  validated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER controlled_output_validation_immutable BEFORE UPDATE OR DELETE ON controlled_output_validation
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Whether an attached document (category B) is the bound template revision filled in, or another format.
CREATE TABLE controlled_attachment_check (
  link_id               uuid PRIMARY KEY REFERENCES evidence_link(id),
  template_revision_id  uuid NOT NULL REFERENCES controlled_document_revision(id),
  conforms              boolean NOT NULL,
  detail                text NOT NULL,
  checked_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER controlled_attachment_check_immutable BEFORE UPDATE OR DELETE ON controlled_attachment_check
  FOR EACH ROW EXECUTE FUNCTION immutable_row();
