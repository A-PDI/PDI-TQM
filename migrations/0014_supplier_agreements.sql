-- Supplier agreements and controlled quality specifications (owner request, 12 Nov 2026).
-- Additive and forward-only: existing rows are not rewritten. New concepts get new tables; existing
-- records gain nullable columns. See docs/construction/SUPPLIER_AGREEMENTS.md.

-- ---------------------------------------------------------------- Document Library
-- Coded documents outside the Appendix B registry (e.g. SCS-001, MSA-001) are specifications, not forms.
ALTER TABLE controlled_document DROP CONSTRAINT controlled_document_kind_check;
ALTER TABLE controlled_document ADD CONSTRAINT controlled_document_kind_check CHECK (kind IN ('FORM', 'CONTINUATION', 'LIBRARY', 'SPECIFICATION'));

-- Configurable categories of controlled technical specifications (data, not code).
CREATE TABLE specification_category (
  code         text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  label        text NOT NULL,
  description  text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO specification_category (code, label, description) VALUES
  ('CASTING', 'Cast components', 'Cast iron, cast steel and aluminum castings'),
  ('FORGING', 'Forged components', 'Forgings and forged blanks'),
  ('MACHINING', 'Precision-machined components', 'Machined parts and features'),
  ('FUEL_CLEANLINESS', 'Fuel-system cleanliness', 'Cleanliness of fuel-system components'),
  ('COATING', 'Coatings and surface treatments', 'Plating, coating, heat and surface treatments'),
  ('ELECTRONICS', 'Electronic assemblies', 'Electronic and electrical assemblies'),
  ('MARKING', 'Product marking and traceability', 'Identification, logo and traceability marking'),
  ('PACKAGING', 'Packaging and preservation', 'Packaging, preservation and labelling');
CREATE FUNCTION specification_category_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'specification categories are retired, not deleted' USING ERRCODE = 'P0001'; END IF;
  IF NEW.code <> OLD.code THEN RAISE EXCEPTION 'a specification category code is immutable' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER specification_category_guard BEFORE UPDATE OR DELETE ON specification_category
  FOR EACH ROW EXECUTE FUNCTION specification_category_guard();

-- How a controlled document takes part in supplier agreements, and where it applies.
CREATE TABLE document_classification (
  document_id         uuid PRIMARY KEY REFERENCES controlled_document(id),
  classification      text NOT NULL CHECK (classification IN ('MASTER_AGREEMENT', 'QUALITY_AGREEMENT', 'TECHNICAL_SPECIFICATION')),
  category_code       text REFERENCES specification_category(code),
  product_families    text[] NOT NULL DEFAULT '{}',
  materials           text[] NOT NULL DEFAULT '{}',
  processes           text[] NOT NULL DEFAULT '{}',
  default_precedence  integer NOT NULL DEFAULT 50 CHECK (default_precedence BETWEEN 1 AND 999),
  scope_note          text,
  version             integer NOT NULL DEFAULT 1,
  updated_by          uuid NOT NULL REFERENCES app_user(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((classification = 'TECHNICAL_SPECIFICATION') = (category_code IS NOT NULL))
);
CREATE FUNCTION document_classification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a document classification is changed, never deleted' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_classification_guard BEFORE DELETE ON document_classification
  FOR EACH ROW EXECUTE FUNCTION document_classification_guard();

-- Clauses of one exact revision, so characteristics, inspections and NCRs can cite them.
CREATE TABLE document_clause (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id  uuid NOT NULL REFERENCES controlled_document_revision(id),
  clause_ref   text NOT NULL CHECK (length(clause_ref) BETWEEN 1 AND 40),
  title        text NOT NULL,
  sort_order   integer NOT NULL,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (revision_id, clause_ref)
);
CREATE TRIGGER document_clause_immutable BEFORE UPDATE OR DELETE ON document_clause
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- ---------------------------------------------------------------- parts and part schedules
-- Applicability attributes beside the existing product family.
ALTER TABLE company_part ADD COLUMN material text;
ALTER TABLE company_part ADD COLUMN manufacturing_process text;

-- Technical baselines are the part-specific schedules (Annex A): they gain the governing
-- specification revision, structured schedule content and clause references, all frozen on
-- release by the existing guards.
ALTER TABLE baseline_revision ADD COLUMN governing_spec_revision_id uuid REFERENCES controlled_document_revision(id);
ALTER TABLE baseline_revision ADD COLUMN schedule jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE baseline_characteristic ADD COLUMN spec_reference text;

-- ---------------------------------------------------------------- supplier acknowledgment (extended)
-- An acknowledgment concerns either a baseline revision of a source (as before) or a controlled
-- document revision for a supplier (optionally one site). It stays revision-specific.
ALTER TABLE supplier_acknowledgment ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE supplier_acknowledgment ALTER COLUMN baseline_revision_id DROP NOT NULL;
ALTER TABLE supplier_acknowledgment ADD COLUMN supplier_id uuid REFERENCES supplier(id);
ALTER TABLE supplier_acknowledgment ADD COLUMN site_id uuid REFERENCES supplier_site(id);
ALTER TABLE supplier_acknowledgment ADD COLUMN document_revision_id uuid REFERENCES controlled_document_revision(id);
ALTER TABLE supplier_acknowledgment ADD COLUMN exceptions text;
ALTER TABLE supplier_acknowledgment ADD CONSTRAINT supplier_acknowledgment_subject_check CHECK (
  (baseline_revision_id IS NOT NULL AND source_id IS NOT NULL AND document_revision_id IS NULL)
  OR (document_revision_id IS NOT NULL AND supplier_id IS NOT NULL AND baseline_revision_id IS NULL AND source_id IS NULL)
);
CREATE UNIQUE INDEX supplier_acknowledgment_document_pending ON supplier_acknowledgment
  (supplier_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), document_revision_id)
  WHERE response = 'PENDING' AND document_revision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION acknowledgment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'acknowledgments cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.response <> 'PENDING'
     OR (NEW.source_id, NEW.baseline_revision_id, NEW.supplier_id, NEW.site_id, NEW.document_revision_id, NEW.sent_via, NEW.sent_to, NEW.sent_at, NEW.sent_by)
        IS DISTINCT FROM (OLD.source_id, OLD.baseline_revision_id, OLD.supplier_id, OLD.site_id, OLD.document_revision_id, OLD.sent_via, OLD.sent_to, OLD.sent_at, OLD.sent_by) THEN
    RAISE EXCEPTION 'a supplier response is recorded once against the exact revision sent' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- operational references
ALTER TABLE inspection ADD COLUMN specification_snapshot jsonb;
ALTER TABLE fai_sample ADD COLUMN specification_snapshot jsonb;
ALTER TABLE ncr ADD COLUMN governing_revision_id uuid REFERENCES controlled_document_revision(id);
ALTER TABLE ncr ADD COLUMN governing_clause text;
ALTER TABLE ncr ADD COLUMN governing_baseline_revision_id uuid REFERENCES baseline_revision(id);

-- ---------------------------------------------------------------- supplier agreement packages
CREATE TABLE supplier_agreement (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               text NOT NULL UNIQUE,
  supplier_id          uuid NOT NULL REFERENCES supplier(id),
  kind                 text NOT NULL CHECK (kind IN ('AGREEMENT', 'AMENDMENT', 'RENEWAL')),
  parent_id            uuid REFERENCES supplier_agreement(id),
  title                text NOT NULL,
  -- The contracting legal entity as named when prepared; supplier renames never rewrite it.
  legal_entity         text NOT NULL,
  product_families     text[] NOT NULL DEFAULT '{}',
  change_summary       text,
  exceptions           text,
  effective_from       date,
  expires_on           date,
  status               text NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT', 'IN_REVIEW', 'AWAITING_EXECUTION', 'EXECUTED', 'SUPERSEDED', 'TERMINATED', 'CANCELLED')),
  cycle                integer NOT NULL DEFAULT 1,
  manifest_sha256      text,
  prepared_by          uuid NOT NULL REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  submitted_by         uuid REFERENCES app_user(id),
  submitted_at         timestamptz,
  approved_by          uuid REFERENCES app_user(id),
  approved_at          timestamptz,
  conflict_resolution  text,
  execution_recorded_by uuid REFERENCES app_user(id),
  executed_at          timestamptz,
  -- The signed agreement as received (an evidence file linked to this agreement).
  executed_file_id     uuid REFERENCES file_object(id),
  superseded_by_id     uuid REFERENCES supplier_agreement(id),
  superseded_at        timestamptz,
  terminated_by        uuid REFERENCES app_user(id),
  terminated_at        timestamptz,
  termination_reason   text,
  cancelled_by         uuid REFERENCES app_user(id),
  cancelled_at         timestamptz,
  cancel_reason        text,
  version              integer NOT NULL DEFAULT 1,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'AGREEMENT') = (parent_id IS NULL)),
  CHECK (expires_on IS NULL OR effective_from IS NULL OR expires_on >= effective_from),
  CHECK (status NOT IN ('AWAITING_EXECUTION', 'EXECUTED', 'SUPERSEDED', 'TERMINATED') OR (approved_by IS NOT NULL AND manifest_sha256 IS NOT NULL)),
  CHECK (status NOT IN ('EXECUTED', 'SUPERSEDED', 'TERMINATED') OR (executed_at IS NOT NULL AND effective_from IS NOT NULL AND executed_file_id IS NOT NULL)),
  CHECK (status <> 'SUPERSEDED' OR superseded_at IS NOT NULL),
  CHECK (status <> 'TERMINATED' OR (terminated_by IS NOT NULL AND termination_reason IS NOT NULL)),
  CHECK (status <> 'CANCELLED' OR (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX supplier_agreement_supplier_idx ON supplier_agreement (supplier_id, status);
CREATE INDEX supplier_agreement_parent_idx ON supplier_agreement (parent_id);

CREATE FUNCTION supplier_agreement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  terminal_keys text[] := ARRAY['status', 'superseded_by_id', 'superseded_at', 'terminated_by', 'terminated_at', 'termination_reason', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier agreement % cannot be deleted; cancel or terminate it', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF NEW.number <> OLD.number OR NEW.supplier_id <> OLD.supplier_id OR NEW.kind <> OLD.kind OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity and supplier of agreement % are immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('SUPERSEDED', 'TERMINATED', 'CANCELLED') THEN
    RAISE EXCEPTION 'agreement % is % and cannot change', OLD.number, lower(OLD.status) USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'EXECUTED' THEN
    -- An executed agreement only ends: superseded by an executed renewal, or terminated.
    IF NEW.status NOT IN ('EXECUTED', 'SUPERSEDED', 'TERMINATED') OR (to_jsonb(NEW) - terminal_keys) <> (to_jsonb(OLD) - terminal_keys) THEN
      RAISE EXCEPTION 'executed agreement % is immutable; amend or renew it', OLD.number USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF (to_jsonb(NEW) -> 'title', to_jsonb(NEW) -> 'legal_entity', to_jsonb(NEW) -> 'product_families', to_jsonb(NEW) -> 'change_summary', to_jsonb(NEW) -> 'exceptions', to_jsonb(NEW) -> 'expires_on')
       IS DISTINCT FROM (to_jsonb(OLD) -> 'title', to_jsonb(OLD) -> 'legal_entity', to_jsonb(OLD) -> 'product_families', to_jsonb(OLD) -> 'change_summary', to_jsonb(OLD) -> 'exceptions', to_jsonb(OLD) -> 'expires_on') THEN
      RAISE EXCEPTION 'agreement % is %; return it to draft to change its terms', OLD.number, lower(OLD.status) USING ERRCODE = 'P0001';
    END IF;
    IF NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256 AND OLD.manifest_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'the approved manifest of agreement % is immutable', OLD.number USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_agreement_guard BEFORE UPDATE OR DELETE ON supplier_agreement
  FOR EACH ROW EXECUTE FUNCTION supplier_agreement_guard();

-- Manufacturing sites an agreement covers (never implied: one site's agreement covers no other).
CREATE TABLE supplier_agreement_site (
  agreement_id  uuid NOT NULL REFERENCES supplier_agreement(id),
  site_id       uuid NOT NULL REFERENCES supplier_site(id),
  PRIMARY KEY (agreement_id, site_id)
);

-- The package manifest: each incorporated document at one exact revision, with its applicability.
CREATE TABLE supplier_agreement_document (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id              uuid NOT NULL REFERENCES supplier_agreement(id),
  role                      text NOT NULL CHECK (role IN ('MASTER_AGREEMENT', 'QUALITY_AGREEMENT', 'SPECIFICATION', 'PART_SCHEDULE', 'EXHIBIT')),
  action                    text NOT NULL DEFAULT 'INCORPORATE' CHECK (action IN ('INCORPORATE', 'REPLACE', 'REMOVE')),
  document_revision_id      uuid REFERENCES controlled_document_revision(id),
  baseline_revision_id      uuid REFERENCES baseline_revision(id),
  file_id                   uuid REFERENCES file_object(id),
  document_number           text NOT NULL,
  title                     text NOT NULL,
  revision_label            text NOT NULL,
  sha256                    text NOT NULL,
  precedence                integer NOT NULL CHECK (precedence BETWEEN 1 AND 999),
  contractual_ref           text NOT NULL,
  applies_site_ids          uuid[] NOT NULL DEFAULT '{}',
  applies_part_ids          uuid[] NOT NULL DEFAULT '{}',
  applies_product_families  text[] NOT NULL DEFAULT '{}',
  applicability_note        text,
  sort_order                integer NOT NULL,
  CHECK (num_nonnulls(document_revision_id, baseline_revision_id, file_id) = 1),
  CHECK ((role = 'PART_SCHEDULE') = (baseline_revision_id IS NOT NULL)),
  CHECK ((role = 'EXHIBIT') = (file_id IS NOT NULL))
);
CREATE INDEX supplier_agreement_document_agreement_idx ON supplier_agreement_document (agreement_id, sort_order);
CREATE INDEX supplier_agreement_document_revision_idx ON supplier_agreement_document (document_revision_id);

-- Sites and manifest lines change only while their agreement is a draft; the site must be the supplier's.
CREATE FUNCTION supplier_agreement_part_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  SELECT status, supplier_id, number INTO a FROM supplier_agreement
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.agreement_id ELSE NEW.agreement_id END;
  IF a.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the contents of agreement % are frozen once it leaves draft', a.number USING ERRCODE = 'P0001';
  END IF;
  -- Nested: NEW.site_id exists only on supplier_agreement_site (PL/pgSQL does not short-circuit AND).
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'supplier_agreement_site' THEN
    IF NOT EXISTS (SELECT 1 FROM supplier_site WHERE id = NEW.site_id AND supplier_id = a.supplier_id) THEN
      RAISE EXCEPTION 'site does not belong to the agreement supplier' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_agreement_site_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_agreement_site
  FOR EACH ROW EXECUTE FUNCTION supplier_agreement_part_guard();
CREATE TRIGGER supplier_agreement_document_guard BEFORE INSERT OR UPDATE OR DELETE ON supplier_agreement_document
  FOR EACH ROW EXECUTE FUNCTION supplier_agreement_part_guard();

-- Internal approval, legal review reference and execution evidence: separate, immutable entries.
CREATE TABLE supplier_agreement_signature (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id     uuid NOT NULL REFERENCES supplier_agreement(id),
  cycle            integer NOT NULL,
  role             text NOT NULL CHECK (role IN ('PDI_APPROVAL', 'LEGAL_REVIEW', 'PDI_SIGNATORY', 'SUPPLIER_SIGNATORY')),
  mode             text NOT NULL CHECK (mode IN ('INTERNAL', 'EXTERNAL')),
  -- INTERNAL: the TQM user who approved. EXTERNAL: the TQM user who recorded it from the signed document.
  signer_id        uuid NOT NULL REFERENCES app_user(id),
  signer_name      text NOT NULL,
  signer_title     text,
  signed_on        date NOT NULL,
  reference        text,
  statement        text,
  manifest_sha256  text NOT NULL,
  grants_used      text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, cycle, role)
);
CREATE TRIGGER supplier_agreement_signature_immutable BEFORE UPDATE OR DELETE ON supplier_agreement_signature
  FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- ---------------------------------------------------------------- work items
ALTER TABLE work_item DROP CONSTRAINT work_item_kind_check;
ALTER TABLE work_item ADD CONSTRAINT work_item_kind_check CHECK (kind IN (
  'INSPECTION_ASSIGNED', 'INSPECTION_REVIEW', 'CONCERN_TRIAGE', 'CONCERN_FOLLOW_UP',
  'QUALIFICATION_DECISION', 'BASELINE_RELEASE', 'FAI_DECISION', 'SOURCE_APPROVAL', 'SUPPLIER_RESPONSE', 'SOURCING_REQUEST',
  'NCR_ACTION', 'CONTAINMENT_AUTHORIZATION', 'SEGREGATION_VERIFICATION', 'DISPOSITION_DECISION', 'DISPOSITION_VERIFICATION',
  'MATERIAL_RELEASE', 'CONCESSION_DECISION', 'SCAR_RESPONSE', 'SCAR_VERIFICATION', 'COMMITMENT_FOLLOW_UP', 'COMMITMENT_ESCALATION',
  'CHANGE_IMPACT', 'CHANGE_DECISION', 'CHANGE_ACTION', 'CHANGE_VERIFICATION', 'FORM_RELEASE',
  'AGREEMENT_REVIEW', 'AGREEMENT_EXECUTION', 'AGREEMENT_REVISION_REVIEW'));
