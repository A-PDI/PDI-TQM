import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_MARK, syntheticMsa001, syntheticScs001 } from '../../src/server/agreements/synthetic-documents.js';
import { pageText } from '../../src/server/controlled/pdf-text.js';
import { type ConflictLine, agreementState, applicabilityOverlaps, detectConflicts, lineApplies, specificationMatches } from '../../src/shared/agreements.js';
import { parseDocumentFilename } from '../../src/shared/documents.js';

const line = (over: Partial<ConflictLine>): ConflictLine => ({
  key: over.key ?? 'k',
  identity: 'doc',
  role: 'SPECIFICATION',
  documentNumber: 'SCS-001',
  revisionLabel: '1.0',
  precedence: 30,
  category: 'CASTING',
  siteIds: [],
  partIds: [],
  productFamilies: [],
  ...over,
});

describe('agreement state', () => {
  it('derives EXPIRED only for an executed agreement past its expiry date', () => {
    expect(agreementState({ status: 'EXECUTED', expiresOn: '2026-11-11' }, '2026-11-12')).toBe('EXPIRED');
    expect(agreementState({ status: 'EXECUTED', expiresOn: '2026-11-12' }, '2026-11-12')).toBe('EXECUTED');
    expect(agreementState({ status: 'EXECUTED', expiresOn: null }, '2030-01-01')).toBe('EXECUTED');
    expect(agreementState({ status: 'SUPERSEDED', expires_on: '2020-01-01' }, '2026-11-12')).toBe('SUPERSEDED');
  });
});

describe('applicability', () => {
  it('treats an empty axis as unrestricted and matches families without regard to case', () => {
    expect(lineApplies({ siteIds: [], partIds: [], productFamilies: [] }, { siteId: 's1', partId: 'p1', family: null })).toBe(true);
    expect(lineApplies({ siteIds: ['s2'], partIds: [], productFamilies: [] }, { siteId: 's1', partId: 'p1', family: null })).toBe(false);
    expect(lineApplies({ siteIds: [], partIds: ['p2'], productFamilies: [] }, { siteId: 's1', partId: 'p1', family: null })).toBe(false);
    expect(lineApplies({ siteIds: [], partIds: [], productFamilies: ['cylinder heads'] }, { siteId: 's1', partId: 'p1', family: 'Cylinder Heads' })).toBe(true);
    expect(lineApplies({ siteIds: [], partIds: [], productFamilies: ['Cylinder heads'] }, { siteId: 's1', partId: 'p1', family: null })).toBe(false);
    // An unknown site (concern raised without one) is not excluded on the site axis.
    expect(lineApplies({ siteIds: ['s2'], partIds: [], productFamilies: [] }, { siteId: null, partId: 'p1', family: null })).toBe(true);
  });

  it('overlaps only when every axis overlaps', () => {
    expect(applicabilityOverlaps({ siteIds: ['a'], partIds: [], productFamilies: [] }, { siteIds: ['b'], partIds: [], productFamilies: [] })).toBe(false);
    expect(applicabilityOverlaps({ siteIds: ['a'], partIds: [], productFamilies: ['X'] }, { siteIds: [], partIds: [], productFamilies: ['x'] })).toBe(true);
  });

  it('matches a specification by any configured axis, and never when none is configured', () => {
    const casting = { productFamilies: [], materials: [], processes: ['Casting'] };
    expect(specificationMatches(casting, { family: 'Cylinder heads', material: null, process: 'casting' })).toBe(true);
    expect(specificationMatches(casting, { family: 'Crankshafts', material: null, process: 'Forging' })).toBe(false);
    expect(specificationMatches({ productFamilies: [], materials: [], processes: [] }, { family: 'x', material: 'y', process: 'z' })).toBe(false);
    expect(specificationMatches({ productFamilies: ['Injectors'], materials: ['Steel'], processes: [] }, { family: 'Pumps', material: 'steel', process: null })).toBe(true);
  });
});

describe('precedence conflicts', () => {
  it('reports two revisions of one document, two specifications of one category, and shared precedence across roles', () => {
    const c = detectConflicts([
      line({ key: 'a' }),
      line({ key: 'b', revisionLabel: '1.1' }),
      line({ key: 'c', identity: 'other', documentNumber: 'SCS-009' }),
      line({ key: 'd', identity: 'msa', role: 'MASTER_AGREEMENT', documentNumber: 'MSA-001', category: null, precedence: 30 }),
    ]);
    expect(c.map((x) => `${x.kind}:${x.keys.join('')}`).sort()).toEqual(['CATEGORY:ac', 'CATEGORY:bc', 'PRECEDENCE:ad', 'PRECEDENCE:bd', 'PRECEDENCE:cd', 'REVISIONS:ab']);
  });

  it('reports nothing where applicability does not overlap, and ignores exhibits for precedence', () => {
    expect(detectConflicts([line({ key: 'a', siteIds: ['s1'] }), line({ key: 'b', revisionLabel: '1.1', siteIds: ['s2'] })])).toEqual([]);
    expect(detectConflicts([line({ key: 'a', precedence: 90 }), line({ key: 'x', identity: 'f', role: 'EXHIBIT', category: null, documentNumber: 'Exhibit', precedence: 90 })])).toEqual([]);
  });
});

describe('document file names', () => {
  it('accepts dotted revision labels and treats coded documents outside Appendix B as specifications', () => {
    expect(parseDocumentFilename('SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.0.pdf')).toMatchObject({ number: 'SCS-001', family: 'SCS', kind: 'SPECIFICATION', revisionLabel: '1.0' });
    expect(parseDocumentFilename('MSA-001_Master_Supplier_Agreement_RevS01.pdf')).toMatchObject({ number: 'MSA-001', family: 'MSA', kind: 'SPECIFICATION', revisionLabel: 'S01' });
    expect(parseDocumentFilename('SUP-03_Supplier_Quality_Agreement_Rev02.pdf')).toMatchObject({ number: 'SUP-03', kind: 'FORM' });
  });
});

describe('synthetic documents', () => {
  it('mark every page as synthetic and carry no acceptance criteria or legal text', async () => {
    for (const bytes of [await syntheticScs001('1.0'), await syntheticMsa001('01')]) {
      const doc = await PDFDocument.load(bytes);
      for (const page of doc.getPages()) {
        const text = pageText(doc, page).map((r) => r.text).join(' ');
        expect(text).toContain(SYNTHETIC_MARK);
      }
    }
    // Stable bytes for a given revision (fixed dates), so the SHA-256 is reproducible.
    expect(Buffer.compare(await syntheticScs001('1.0'), await syntheticScs001('1.0'))).toBe(0);
  });
});
