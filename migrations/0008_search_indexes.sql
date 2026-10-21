-- Stage 5 performance: index-backed serial normalization and substring search, so traceability and
-- list search stay fast with many years of inspections (FR-114). pg_trgm is a trusted extension
-- shipped with PostgreSQL; the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Same expression as the queries (normalizeSerial: upper-case letters and digits only).
CREATE INDEX inspection_unit_serial_norm_idx ON inspection_unit ((upper(regexp_replace(coalesce(serial_number, ''), '[^A-Za-z0-9]', '', 'g'))));
CREATE INDEX quality_event_serial_norm_idx ON quality_event ((upper(regexp_replace(coalesce(serial_number, ''), '[^A-Za-z0-9]', '', 'g'))));

-- Substring (ILIKE '%term%') search.
CREATE INDEX inspection_unit_serial_trgm_idx ON inspection_unit USING gin (serial_number gin_trgm_ops);
CREATE INDEX inspection_number_trgm_idx ON inspection USING gin (number gin_trgm_ops);
CREATE INDEX inspection_lot_trgm_idx ON inspection USING gin (lot_number gin_trgm_ops);
CREATE INDEX inspection_po_trgm_idx ON inspection USING gin (po_number gin_trgm_ops);
CREATE INDEX inspection_part_number_trgm_idx ON inspection USING gin (part_number gin_trgm_ops);
CREATE INDEX inspection_part_description_trgm_idx ON inspection USING gin (part_description gin_trgm_ops);

-- Report periods filter completed inspections by completion time.
CREATE INDEX inspection_completed_at_idx ON inspection (completed_at) WHERE status = 'COMPLETED';
