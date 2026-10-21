// Characters the standard PDF fonts (WinAnsiEncoding) can render beyond Latin-1.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACEMENTS: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '≤': '<=',
  '≥': '>=',
  '″': '"',
  '′': "'",
  '✓': 'Pass',
  '✗': 'Fail',
  '−': '-',
  ' ': ' ',
};

/** Makes arbitrary text safe for the built-in Helvetica fonts. */
export function pdfText(input: string | null | undefined): string {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (code === 0x0a || (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (code === 0x09) out += ' ';
    else out += '?';
  }
  return out;
}

export function formatDate(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-');
    return `${m}/${d}/${y}`;
  }
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function formatDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(new Date(iso));
  return s.replace(',', '');
}
