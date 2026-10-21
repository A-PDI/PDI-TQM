import { crc32, deflateSync } from 'node:zlib';

/** Fabricated test imagery (never real report photographs): a solid-color RGB PNG with a stripe. */
export function makePng(width = 64, height = 48, rgb: [number, number, number] = [90, 110, 140]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const stripe = Math.floor(x / 8) % 2 === 0;
      raw[o] = stripe ? rgb[0] : 230;
      raw[o + 1] = stripe ? rgb[1] : 230;
      raw[o + 2] = stripe ? rgb[2] : 230;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
