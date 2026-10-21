-- Master data (suppliers, sites, parts, aliases, supplier parts), technical baselines
-- with immutable released revisions, exact sources, and controlled inspection forms.

CREATE TABLE supplier (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  legal_name    text NOT NULL,
  trading_name  text,
  category      text,
  status        text NOT NULL DEFAULT 'PROSPECTIVE' CHECK (status IN ('PROSPECTIVE', 'ACTIVE', 'INACTIVE')),
  notes         text,
  is_synthetic  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user(id)
);

CREATE TABLE supplier_site (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid NOT NULL REFERENCES supplier(id),
  code          text NOT NULL,
  name          text NOT NULL,
  address       text,
  country       text,
  -- Site qualification is a separate gated record (Stage 2); this is operational presence only.
  status        text NOT NULL DEFAULT 'PROSPECTIVE' CHECK (status IN ('PROSPECTIVE', 'ACTIVE', 'INACTIVE')),
  is_synthetic  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, code)
);

CREATE TABLE company_part (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number        text NOT NULL,
  description        text NOT NULL,
  family             text,
  criticality        text NOT NULL DEFAULT 'UNCLASSIFIED'
                     CHECK (criticality IN ('UNCLASSIFIED', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  design_owner       text NOT NULL DEFAULT 'UNDETERMINED' CHECK (design_owner IN ('PDI', 'SUPPLIER', 'UNDETERMINED')),
  default_form_number text,
  active             boolean NOT NULL DEFAULT true,
  is_synthetic       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES app_user(id)
);
CREATE UNIQUE INDEX company_part_number_key ON company_part (upper(part_number));

CREATE TABLE part_alias (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id     uuid NOT NULL REFERENCES company_part(id),
  alias       text NOT NULL,
  alias_type  text NOT NULL DEFAULT 'OE' CHECK (alias_type IN ('OE', 'LEGACY', 'CUSTOMER', 'OTHER')),
  normalized  text NOT NULL,
  UNIQUE (part_id, normalized)
);
CREATE INDEX part_alias_normalized_idx ON part_alias (normalized);

CREATE TABLE supplier_part (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id           uuid NOT NULL REFERENCES supplier(id),
  supplier_part_number  text NOT NULL,
  description           text,
  normalized            text NOT NULL,
  UNIQUE (supplier_id, normalized)
);

CREATE TABLE technical_baseline (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id     uuid NOT NULL REFERENCES company_part(id),
  title       text NOT NULL,
  ownership   text NOT NULL CHECK (ownership IN ('PDI', 'SUPPLIER', 'SUPPLIER_PLUS_DELTA')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app_user(id)
);

CREATE TABLE baseline_revision (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id     uuid NOT NULL REFERENCES technical_baseline(id),
  revision_label  text NOT NULL,
  status          text NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'IN_REVIEW', 'RELEASED', 'SUPERSEDED', 'OBSOLETE')),
  is_synthetic    boolean NOT NULL DEFAULT false,
  document_ref    text,
  notes           text,
  authored_by     uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  released_by     uuid REFERENCES app_user(id),
  released_at     timestamptz,
  effective_from  date,
  UNIQUE (baseline_id, revision_label),
  CHECK (status NOT IN ('RELEASED', 'SUPERSEDED') OR (released_by IS NOT NULL AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX baseline_one_released ON baseline_revision (baseline_id) WHERE status = 'RELEASED';

CREATE TABLE baseline_characteristic (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id   uuid NOT NULL REFERENCES baseline_revision(id),
  char_key      text NOT NULL,
  name          text NOT NULL,
  char_type     text NOT NULL DEFAULT 'DIMENSIONAL' CHECK (char_type IN ('DIMENSIONAL', 'VISUAL', 'FUNCTIONAL', 'MATERIAL')),
  -- Link to an inspection form row: "<form section pattern>:<row key>" e.g. "dimensional:free_end_gap_relaxed".
  form_row_ref  text,
  unit          text,
  lower_limit   numeric,
  upper_limit   numeric,
  nominal       numeric,
  limit_text    text,
  method        text,
  location      text,
  special       boolean NOT NULL DEFAULT false,
  UNIQUE (revision_id, char_key),
  CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit),
  CHECK ((lower_limit IS NULL AND upper_limit IS NULL) OR unit IS NOT NULL)
);

-- Released technical content is immutable; only the RELEASED -> SUPERSEDED/OBSOLETE transition is allowed.
CREATE FUNCTION baseline_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only draft baseline revisions can be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('RELEASED', 'SUPERSEDED', 'OBSOLETE') THEN
    IF NOT (OLD.status = 'RELEASED' AND NEW.status IN ('SUPERSEDED', 'OBSOLETE'))
       OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'released baseline revision % is immutable', OLD.revision_label USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER baseline_revision_guard BEFORE UPDATE OR DELETE ON baseline_revision
  FOR EACH ROW EXECUTE FUNCTION baseline_revision_guard();

CREATE FUNCTION baseline_characteristic_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rev_status text;
BEGIN
  SELECT status INTO rev_status FROM baseline_revision
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.revision_id ELSE OLD.revision_id END;
  IF rev_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'characteristics of a % baseline revision cannot be changed', rev_status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER baseline_characteristic_guard BEFORE INSERT OR UPDATE OR DELETE ON baseline_characteristic
  FOR EACH ROW EXECUTE FUNCTION baseline_characteristic_guard();

-- Exact source identity: part + supplier + site + supplier part + configuration + governing baseline revision.
CREATE TABLE source (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id               uuid NOT NULL REFERENCES company_part(id),
  supplier_id           uuid NOT NULL REFERENCES supplier(id),
  site_id               uuid NOT NULL REFERENCES supplier_site(id),
  supplier_part_id      uuid NOT NULL REFERENCES supplier_part(id),
  configuration         text NOT NULL DEFAULT 'STANDARD',
  baseline_revision_id  uuid REFERENCES baseline_revision(id),
  pathway               text NOT NULL CHECK (pathway IN ('A', 'B', 'C')),
  conditions            text,
  -- Approval decisions are gated records (Stage 2). Until then every source reads NOT_APPROVED.
  approval_state        text NOT NULL DEFAULT 'NOT_APPROVED'
                        CHECK (approval_state IN ('NOT_APPROVED', 'IN_REVIEW', 'APPROVED_CONDITIONAL', 'APPROVED')),
  is_synthetic          boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES app_user(id)
);
CREATE UNIQUE INDEX source_identity_key ON source
  (part_id, supplier_id, site_id, supplier_part_id, configuration, coalesce(baseline_revision_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE FUNCTION source_site_matches_supplier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supplier_site WHERE id = NEW.site_id AND supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION 'source site does not belong to source supplier' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_part WHERE id = NEW.supplier_part_id AND supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION 'source supplier part does not belong to source supplier' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_site_matches_supplier BEFORE INSERT OR UPDATE ON source
  FOR EACH ROW EXECUTE FUNCTION source_site_matches_supplier();

CREATE TABLE inspection_form (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_number  text NOT NULL UNIQUE,
  component    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_revision (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id            uuid NOT NULL REFERENCES inspection_form(id),
  sequence           integer NOT NULL,
  revision_label     text,
  status             text NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'IN_REVIEW', 'RELEASED', 'SUPERSEDED', 'OBSOLETE')),
  definition         jsonb NOT NULL,
  definition_sha256  text NOT NULL,
  provenance         text NOT NULL,
  change_summary     text,
  created_by         uuid REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  released_by        uuid REFERENCES app_user(id),
  released_at        timestamptz,
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, sequence)
);
CREATE UNIQUE INDEX form_revision_one_released ON form_revision (form_id) WHERE status = 'RELEASED';

CREATE FUNCTION form_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status IN ('SUPERSEDED', 'OBSOLETE') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'superseded or obsolete form revisions cannot change status' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_revision_guard BEFORE UPDATE OR DELETE ON form_revision
  FOR EACH ROW EXECUTE FUNCTION form_revision_guard();
