import { crc32 } from 'node:zlib';
import { makePng } from '../../src/server/fictional-image.js';

export { makePng };

/** A PNG whose header claims enormous dimensions (decompression-bomb shape). */
export function makeBombPngHeader(): Buffer {
  const png = makePng(4, 4);
  const out = Buffer.from(png);
  out.writeUInt32BE(50_000, 16);
  out.writeUInt32BE(50_000, 20);
  // Recompute IHDR CRC so the header itself is well-formed.
  const crc = crc32(out.subarray(12, 29)) >>> 0;
  out.writeUInt32BE(crc, 29);
  return out;
}
