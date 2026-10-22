-- Controlled quality-system document library (FR-008, FR-090, FR-091; Appendix B).
-- A document is the controlled identity (number, family, kind); every released edition is an
-- immutable revision holding the original PDF. Which revision is current is derived from the
-- effective dates, so nothing is ever edited in place.

CREATE TABLE controlled_document (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  type_code        text,
  family           text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('FORM', 'CONTINUATION', 'LIBRARY')),
  title            text NOT NULL,
  owner_role       text NOT NULL DEFAULT 'administrator',
  retention_class  text,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'LIBRARY') = (type_code IS NULL))
);
CREATE INDEX controlled_document_type_idx ON controlled_document (type_code);

CREATE OR REPLACE FUNCTION controlled_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled document % cannot be deleted', OLD.number;
  END IF;
  IF NEW.number <> OLD.number OR NEW.type_code IS DISTINCT FROM OLD.type_code OR NEW.family <> OLD.family OR NEW.kind <> OLD.kind
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity of controlled document % is immutable', OLD.number;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER controlled_document_guard BEFORE UPDATE OR DELETE ON controlled_document
  FOR EACH ROW EXECUTE FUNCTION controlled_document_guard();

CREATE TABLE controlled_document_revision (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES controlled_document(id),
  revision_label  text NOT NULL,
  file_id         uuid NOT NULL REFERENCES file_object(id),
  sha256          text NOT NULL,
  effective_from  date NOT NULL,
  change_summary  text NOT NULL,
  released_by     uuid NOT NULL REFERENCES app_user(id),
  released_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_label)
);
CREATE INDEX controlled_document_revision_doc_idx ON controlled_document_revision (document_id, effective_from DESC, released_at DESC);
CREATE TRIGGER controlled_document_revision_immutable BEFORE UPDATE OR DELETE ON controlled_document_revision
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Owner decision (22 Oct 2026): controlled documents are owned by users with administrator access.
-- The capability row is loaded again (with its description) by the reference data after migrations.
INSERT INTO capability (code, description, sensitive)
VALUES ('documents.control', 'Import and release controlled quality-system documents', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO authority_grant (user_id, capability_code, reason)
SELECT DISTINCT g.user_id, 'documents.control', 'Document owners are administrators (owner decision 22 Oct 2026)'
  FROM authority_grant g JOIN app_user u ON u.id = g.user_id
 WHERE g.capability_code = 'admin.users' AND g.revoked_at IS NULL AND u.active
   AND NOT EXISTS (SELECT 1 FROM authority_grant x WHERE x.user_id = g.user_id AND x.capability_code = 'documents.control' AND x.revoked_at IS NULL);

INSERT INTO audit_event (action, outcome, entity_type, summary)
SELECT 'admin.grant', 'SUCCESS', 'capability', format('documents.control granted to %s active administrator(s): document owners are administrators', count(*))
  FROM authority_grant WHERE capability_code = 'documents.control' AND revoked_at IS NULL;
