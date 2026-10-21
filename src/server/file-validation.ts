import { imageSize } from 'image-size';

export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoMime = (typeof PHOTO_MIME_TYPES)[number];

const MAX_DIMENSION = 12_000;
const MAX_PIXELS = 60_000_000;

export type PhotoValidation =
  | { ok: true; mime: PhotoMime; width: number; height: number }
  | { ok: false; reason: string };

/** Identifies the real type from file signature bytes; the declared type/extension is not trusted. */
export function sniffImage(head: Buffer): PhotoMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Validates an uploaded photograph: signature must be an allowed raster type, the header
 * must parse, and declared dimensions must stay inside decompression-bomb bounds.
 */
export function validatePhoto(head: Buffer, size: number): PhotoValidation {
  if (size === 0) return { ok: false, reason: 'File is empty' };
  const mime = sniffImage(head);
  if (!mime) return { ok: false, reason: 'File is not a JPEG, PNG or WebP photograph' };
  let dims: { width?: number; height?: number; type?: string };
  try {
    dims = imageSize(head);
  } catch {
    return { ok: false, reason: 'Photograph header could not be read' };
  }
  const width = dims.width ?? 0;
  const height = dims.height ?? 0;
  if (width < 1 || height < 1) return { ok: false, reason: 'Photograph has no valid dimensions' };
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    return { ok: false, reason: `Photograph dimensions ${width}×${height} exceed the allowed bounds` };
  }
  const expectedType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
  if (dims.type && dims.type !== expectedType) return { ok: false, reason: 'Photograph content does not match its signature' };
  return { ok: true, mime, width, height };
}

/** Keeps only a safe display basename; never used to address storage. */
export function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? 'upload').split(/[\\/]/).pop() ?? 'upload';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'upload').slice(0, 120);
}
