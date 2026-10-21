-- Stage 0 foundation: identity, grants, sessions, append-only audit, numbering,
-- evidence file metadata, database-backed jobs and the policy register.

CREATE TABLE app_user (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL,
  display_name         text NOT NULL,
  password_hash        text,
  identity_type        text NOT NULL DEFAULT 'LOCAL' CHECK (identity_type IN ('LOCAL', 'SYSTEM')),
  active               boolean NOT NULL DEFAULT true,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES app_user(id),
  deactivated_at       timestamptz,
  deactivated_by       uuid REFERENCES app_user(id)
);
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));

CREATE TABLE capability (
  code         text PRIMARY KEY,
  description  text NOT NULL,
  sensitive    boolean NOT NULL DEFAULT false
);

CREATE TABLE authority_grant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  capability_code  text NOT NULL REFERENCES capability(code),
  scope            text NOT NULL DEFAULT 'ALL',
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_to     timestamptz,
  reason           text,
  granted_by       uuid REFERENCES app_user(id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES app_user(id),
  revoke_reason    text
);
CREATE UNIQUE INDEX authority_grant_active_key
  ON authority_grant (user_id, capability_code, scope) WHERE revoked_at IS NULL;

CREATE TABLE user_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES app_user(id),
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
CREATE INDEX user_session_user_idx ON user_session (user_id);

-- Append-only audit trail. Denied consequential attempts are recorded with outcome DENIED.
CREATE TABLE audit_event (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES app_user(id),
  action       text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILED')),
  entity_type  text,
  entity_id    text,
  summary      text NOT NULL,
  reason       text,
  before_state jsonb,
  after_state  jsonb,
  request_id   text
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id, occurred_at);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_id, occurred_at);

CREATE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% rejected)', TG_OP USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

-- Human-friendly record numbers (e.g. IR-2026-00001), issued under row lock.
CREATE TABLE record_sequence (
  prefix     text NOT NULL,
  year       integer NOT NULL,
  next_value integer NOT NULL DEFAULT 1,
  PRIMARY KEY (prefix, year)
);

-- File bytes live on the private evidence disk; only metadata is stored here.
CREATE TABLE file_object (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('PHOTO', 'DOCUMENT', 'REPORT', 'IMPORT')),
  status            text NOT NULL CHECK (status IN ('UPLOADING', 'VALIDATING', 'AVAILABLE', 'REJECTED', 'FAILED')),
  sha256            text,
  byte_size         bigint,
  mime_type         text,
  original_name     text,
  storage_key       text UNIQUE,
  width             integer,
  height            integer,
  rejection_reason  text,
  uploaded_by       uuid REFERENCES app_user(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'AVAILABLE' OR (sha256 IS NOT NULL AND storage_key IS NOT NULL AND byte_size IS NOT NULL))
);

-- Available originals are immutable: identity, bytes and hash cannot change.
CREATE FUNCTION file_object_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'AVAILABLE' THEN
      RAISE EXCEPTION 'available evidence files cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'AVAILABLE' AND (
       NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type) THEN
    RAISE EXCEPTION 'available evidence files are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_object_immutable BEFORE UPDATE OR DELETE ON file_object
  FOR EACH ROW EXECUTE FUNCTION file_object_immutable();

CREATE TABLE job (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'QUEUED'
                   CHECK (status IN ('QUEUED', 'CLAIMED', 'COMPLETED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  run_after        timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  claimed_by       text,
  completed_at     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_ready_idx ON job (status, run_after) WHERE status IN ('QUEUED', 'FAILED_RETRYABLE', 'CLAIMED');

-- Visible register of business decisions PDI must sign (Construction Drawing E2).
CREATE TABLE policy_decision (
  code               text PRIMARY KEY,
  title              text NOT NULL,
  area               text NOT NULL,
  status             text NOT NULL DEFAULT 'POLICY_OPEN' CHECK (status IN ('POLICY_OPEN', 'PROPOSED', 'APPROVED', 'SUPERSEDED')),
  interim_behavior   text NOT NULL,
  owner              text,
  decision           text,
  decided_at         timestamptz,
  effective_revision text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Small set of system identities, e.g. the evidence volume this database is paired with.
CREATE TABLE system_setting (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
