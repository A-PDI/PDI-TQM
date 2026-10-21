export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
export const forbidden = (message = 'You do not have authority for this action') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', message, details);

/** Maps PostgreSQL integrity-trigger rejections (P0001) to a 409 rather than a 500. */
/** Plain explanations for "only one at a time" rules enforced by unique indexes (migration 0007 and earlier). */
const UNIQUE_MESSAGES: Record<string, string> = {
  repair_case_one_open: 'This injector already has an open repair case',
  supplier_qualification_one_under_review: 'An assessment for this subject is already under review',
  baseline_revision_one_draft: 'A draft or in-review revision already exists for this baseline',
  form_revision_one_draft: 'This form already has a draft or in-review revision',
  supplier_acknowledgment_one_pending: 'An acknowledgment request is already awaiting the supplier response',
  fai_sample_one_open: 'Decide the open sample before registering another',
  quality_event_one_open_per_row: 'An open concern already exists for this characteristic',
  sourcing_request_one_per_source: 'This exact source is already being qualified under another sourcing request',
  injector_test_source_key_key: 'This test is already recorded (same machine, serial, time and sequence)',
  injector_part_id_normalized_serial_key: 'This serial is already registered for the part',
};

export function fromDbError(err: unknown): AppError | null {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e?.code === 'P0001') return conflict(e.message ?? 'Integrity rule rejected the change');
  if (e?.code === '23505') return conflict(UNIQUE_MESSAGES[e.constraint ?? ''] ?? 'A record with the same identity already exists', { constraint: e.constraint });
  if (e?.code === '23503') return unprocessable('A referenced record does not exist', { constraint: e.constraint });
  return null;
}
