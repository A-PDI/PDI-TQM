import { createHash } from 'node:crypto';
import {
  PDFArray,
  PDFContentStream,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  type PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';

/**
 * Minimal content-stream reader for the controlled templates (ReportLab layout engine) and for
 * the PDFs TQM generates from them. It follows q/Q/cm, text state and Form XObjects closely
 * enough to place each text line on the page; it is not a general-purpose text extractor.
 */
export interface TextRun {
  x: number;
  y: number;
  size: number;
  bold: boolean;
  text: string;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

// WinAnsiEncoding differs from Latin-1 only in 0x80–0x9F.
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
const decodeBytes = (bytes: number[]) => bytes.map((b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b)).join('');

type Token = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'str'; v: string } | { t: 'op'; v: string } | { t: '['; v: null } | { t: ']'; v: null } | { t: 'dict'; v: null };

const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

function* tokenize(src: Uint8Array): Generator<Token> {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (c === 0x25) {
      while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x28) {
      // literal string with nesting and escapes
      const out: number[] = [];
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        const ch = src[i]!;
        if (ch === 0x5c) {
          const nx = src[i + 1]!;
          const map: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
          if (nx in map) {
            out.push(map[nx]!);
            i += 2;
          } else if (nx >= 0x30 && nx <= 0x37) {
            let oct = '';
            let j = i + 1;
            while (j < n && oct.length < 3 && src[j]! >= 0x30 && src[j]! <= 0x37) oct += String.fromCharCode(src[j++]!);
            out.push(parseInt(oct, 8) & 0xff);
            i = j;
          } else if (nx === 0x0a || nx === 0x0d) {
            i += nx === 0x0d && src[i + 2] === 0x0a ? 3 : 2;
          } else {
            out.push(nx);
            i += 2;
          }
          continue;
        }
        if (ch === 0x28) depth += 1;
        if (ch === 0x29) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        out.push(ch);
        i += 1;
      }
      yield { t: 'str', v: decodeBytes(out) };
      continue;
    }
    if (c === 0x3c && src[i + 1] === 0x3c) {
      // dictionaries only appear in inline images / marked content; skip to the matching >>
      let depth = 0;
      while (i < n) {
        if (src[i] === 0x3c && src[i + 1] === 0x3c) {
          depth += 1;
          i += 2;
        } else if (src[i] === 0x3e && src[i + 1] === 0x3e) {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else i += 1;
      }
      yield { t: 'dict', v: null };
      continue;
    }
    if (c === 0x3c) {
      let hex = '';
      i += 1;
      while (i < n && src[i] !== 0x3e) {
        if (!isSpace(src[i]!)) hex += String.fromCharCode(src[i]!);
        i += 1;
      }
      i += 1;
      if (hex.length % 2) hex += '0';
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      yield { t: 'str', v: decodeBytes(bytes) };
      continue;
    }
    if (c === 0x5b) {
      i += 1;
      yield { t: '[', v: null };
      continue;
    }
    if (c === 0x5d) {
      i += 1;
      yield { t: ']', v: null };
      continue;
    }
    if (c === 0x2f) {
      let name = '';
      i += 1;
      while (i < n && !isSpace(src[i]!) && !DELIM.has(src[i]!)) name += String.fromCharCode(src[i++]!);
      yield { t: 'name', v: name };
      continue;
    }
    let word = '';
    while (i < n && !isSpace(src[i]!) && !DELIM.has(src[i]!)) word += String.fromCharCode(src[i++]!);
    if (!word) {
      i += 1;
      continue;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) yield { t: 'num', v: Number(word) };
    else {
      if (word === 'BI') {
        // inline image: skip binary data up to EI
        while (i < n && !(src[i] === 0x45 && src[i + 1] === 0x49 && (i + 2 >= n || isSpace(src[i + 2]!)))) i += 1;
        i += 2;
        continue;
      }
      yield { t: 'op', v: word };
    }
  }
}

/** Decoded bytes of a stream object, whether loaded from a file or created by pdf-lib. */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
  const maybe = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  if (typeof maybe.getUnencodedContents === 'function') return maybe.getUnencodedContents();
  throw new Error('Unsupported content stream type');
}

/** The page's content streams in drawing order, decoded. */
export function pageContentStreams(page: PDFPage): Uint8Array[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFArray) {
    const out: Uint8Array[] = [];
    for (let i = 0; i < contents.size(); i += 1) {
      const s = contents.lookup(i);
      if (s && typeof (s as PDFStream).getContents === 'function') out.push(streamBytes(s as PDFStream));
    }
    return out;
  }
  return [streamBytes(contents)];
}

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 of each decoded content stream on the page. */
export const contentStreamHashes = (page: PDFPage) => pageContentStreams(page).map((b) => sha256(b));

/** SHA-256 of the page's decoded content streams joined in order: the template page's static layout. */
export function pageContentHash(page: PDFPage): string {
  const h = createHash('sha256');
  for (const b of pageContentStreams(page)) h.update(b);
  return h.digest('hex');
}

function fontIsBold(resources: PDFDict | undefined, fontName: string): boolean {
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const font = fonts?.lookupMaybe(PDFName.of(fontName), PDFDict);
  const base = font?.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() ?? fontName;
  return /bold/i.test(base);
}

function readNumbers(arr: PDFArray | undefined): Matrix | null {
  if (!arr || arr.size() !== 6) return null;
  const v: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const n = arr.lookup(i);
    if (!(n instanceof PDFNumber)) return null;
    v.push(n.asNumber());
  }
  return v as Matrix;
}

function runStream(doc: PDFDocument, bytes: Uint8Array, resources: PDFDict | undefined, base: Matrix, out: TextRun[], depth: number) {
  const stack: Matrix[] = [];
  let ctm: Matrix = base;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let size = 0;
  let bold = false;
  let line = '';
  let lineAt: Matrix | null = null;
  const operands: Token[] = [];
  let arrayParts: Token[] | null = null;

  const flush = () => {
    if (lineAt && line.trim()) {
      const m = mul(lineAt, ctm);
      out.push({ x: Math.round(m[4] * 100) / 100, y: Math.round(m[5] * 100) / 100, size: Math.round(size * Math.abs(lineAt[3] || 1) * 100) / 100, bold, text: line.replace(/\s+/g, ' ').trim() });
    }
    line = '';
    lineAt = null;
  };
  const show = (s: string) => {
    if (!lineAt) lineAt = tm;
    line += s;
  };
  const nextLine = (tx: number, ty: number) => {
    flush();
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const nums = () => operands.filter((o): o is { t: 'num'; v: number } => o.t === 'num').map((o) => o.v);

  for (const tok of tokenize(bytes)) {
    if (arrayParts) {
      if (tok.t === ']') {
        operands.push({ t: 'str', v: arrayParts.map((p) => (p.t === 'str' ? p.v : p.t === 'num' && p.v < -200 ? ' ' : '')).join('') });
        arrayParts = null;
      } else arrayParts.push(tok);
      continue;
    }
    if (tok.t === '[') {
      arrayParts = [];
      continue;
    }
    if (tok.t !== 'op') {
      operands.push(tok);
      continue;
    }
    const op = tok.v;
    const n = nums();
    switch (op) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        flush();
        ctm = stack.pop() ?? base;
        break;
      case 'cm':
        if (n.length === 6) ctm = mul(n as Matrix, ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'ET':
        flush();
        break;
      case 'Tf': {
        const name = operands.find((o) => o.t === 'name');
        if (n.length) size = n[n.length - 1]!;
        if (name) bold = fontIsBold(resources, name.v as string);
        break;
      }
      case 'TL':
        if (n.length) leading = n[0]!;
        break;
      case 'Tm':
        if (n.length === 6) {
          flush();
          tlm = n as Matrix;
          tm = tlm;
        }
        break;
      case 'Td':
        if (n.length === 2) nextLine(n[0]!, n[1]!);
        break;
      case 'TD':
        if (n.length === 2) {
          leading = -n[1]!;
          nextLine(n[0]!, n[1]!);
        }
        break;
      case 'T*':
        nextLine(0, -leading);
        break;
      case 'Tj':
      case 'TJ': {
        const s = operands.find((o) => o.t === 'str');
        if (s) show(s.v as string);
        break;
      }
      case "'":
      case '"': {
        nextLine(0, -leading);
        const s = operands.find((o) => o.t === 'str');
        if (s) show(s.v as string);
        break;
      }
      case 'Do': {
        const name = operands.find((o) => o.t === 'name');
        if (name && depth < 4) drawXObject(doc, resources, name.v as string, ctm, out, depth + 1);
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  flush();
}

function drawXObject(doc: PDFDocument, resources: PDFDict | undefined, name: string, ctm: Matrix, out: TextRun[], depth: number) {
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return;
  const raw = xobjects.get(PDFName.of(name));
  const obj = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  if (!(obj instanceof PDFRawStream) && !(obj instanceof PDFContentStream)) return;
  const dict = obj.dict;
  if (dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Form') return;
  const matrix = readNumbers(dict.lookupMaybe(PDFName.of('Matrix'), PDFArray)) ?? IDENTITY;
  const own = dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
  runStream(doc, streamBytes(obj), own, mul(matrix, ctm), out, depth);
}

/** Text lines drawn on a page (including text inside Form XObjects such as flattened field appearances). */
export function pageText(doc: PDFDocument, page: PDFPage): TextRun[] {
  const out: TextRun[] = [];
  const resources = page.node.Resources();
  for (const bytes of pageContentStreams(page)) runStream(doc, bytes, resources, IDENTITY, out, 0);
  return out;
}

/** Collapses text for containment checks: case and whitespace are not significant. */
export const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();
