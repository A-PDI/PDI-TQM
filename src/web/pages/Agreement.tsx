import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type AgreementState, CLASSIFICATION_TEXT, type DocumentRole, ROLE_TEXT, SIGNATURE_TEXT, type SignatureRole } from '../../shared/agreements';
import { api, fmtDate, fmtDateTime } from '../api';
import { AgreementStateBadge } from '../components/agreements';
import { FileLinks, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, useLoad } from '../components/ui';

interface Line {
  id?: string;
  role: DocumentRole;
  action: 'INCORPORATE' | 'REPLACE' | 'REMOVE';
  documentRevisionId: string | null;
  baselineRevisionId: string | null;
  fileId: string | null;
  documentId?: string | null;
  documentNumber: string;
  title: string;
  revisionLabel: string;
  sha256?: string;
  precedence: number;
  contractualRef: string;
  siteIds: string[];
  partIds: string[];
  productFamilies: string[];
  applicabilityNote: string | null;
}

interface AgreementData {
  agreement: {
    id: string;
    number: string;
    kind: 'AGREEMENT' | 'AMENDMENT' | 'RENEWAL';
    parentId: string | null;
    title: string;
    legalEntity: string;
    productFamilies: string[];
    changeSummary: string | null;
    exceptions: string | null;
    effectiveFrom: string | null;
    expiresOn: string | null;
    status: string;
    state: AgreementState;
    cycle: number;
    manifestSha256: string | null;
    preparedByName: string;
    createdAt: string;
    approvedByName: string | null;
    approvedAt: string | null;
    conflictResolution: string | null;
    executedAt: string | null;
    executedFileId: string | null;
    supersededById: string | null;
    supersededAt: string | null;
    terminatedAt: string | null;
    terminationReason: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    version: number;
  };
  supplier: { id: string; code: string; legalName: string; status: string };
  sites: Array<{ id: string; code: string; name: string }>;
  supplierSites: Array<{ id: string; code: string; name: string }>;
  lines: Line[];
  parts: Array<{ id: string; partNumber: string }>;
  effective: Line[];
  conflicts: Array<{ kind: string; keys: string[]; message: string }>;
  stale: Array<{ lineId: string; message: string }>;
  signatures: Array<{ id: string; cycle: number; role: SignatureRole; mode: string; signerName: string; signerTitle: string | null; signedOn: string; reference: string | null; statement: string | null; recordedBy: string; createdAt: string }>;
  attachments: Array<{ linkId: string; fileId: string; name: string | null; mime: string; sha256: string; caption: string | null; linkedAt: string; linkedBy: string }>;
  renditions: Array<{ edition: number; stage: string; createdAt: string; fileId: string | null; sha256: string | null; pageCount: number | null; validated: boolean | null; validation: { checks: Array<{ name: string; ok: boolean; detail: string }> } | null }>;
  related: Array<{ id: string; number: string; kind: string; title: string; state: AgreementState; parentId: string | null }>;
  history: Array<{ id: string; occurredAt: string; action: string; outcome: string; summary: string; reason: string | null; actor: string | null }>;
  work: Array<{ id: string; kind: string; title: string; status: string; createdAt: string }>;
  permissions: Record<string, boolean | string | null>;
}

interface Recommendation {
  role: DocumentRole;
  documentRevisionId?: string;
  baselineRevisionId?: string;
  documentNumber: string;
  title: string;
  revisionLabel: string;
  precedence: number;
  reason: string;
  partIds: string[];
  present: boolean;
  contractualRef: string;
}

interface SpecRow {
  documentId: string;
  number: string;
  title: string;
  classification: keyof typeof CLASSIFICATION_TEXT;
  defaultPrecedence: number;
  current: { id: string; revisionLabel: string } | null;
}

const ROLE_OF_CLASS: Record<string, DocumentRole> = { MASTER_AGREEMENT: 'MASTER_AGREEMENT', QUALITY_AGREEMENT: 'QUALITY_AGREEMENT', TECHNICAL_SPECIFICATION: 'SPECIFICATION' };
const words = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export function Agreement() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad<AgreementData>(`/api/agreements/${id}`);
  const p = data?.permissions ?? {};
  const recs = useLoad<Recommendation[]>(p.canEdit ? `/api/agreements/${id}/recommendations` : null, [p.canEdit, data?.agreement.version]);
  const specs = useLoad<SpecRow[]>(p.canEdit ? '/api/specifications' : null, [p.canEdit]);
  const [draft, setDraft] = useState<Line[] | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const { busy, run, banner } = useBusy();
  useEffect(() => {
    if (data) setDraft(data.lines.map((l) => ({ ...l })));
  }, [data]);
  const field = (k: string) => ({ value: f[k] ?? '', onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });
  if (!data || !draft) return <LoadState loading={loading} error={error} />;
  const a = data.agreement;
  const partNo = new Map(data.parts.map((x) => [x.id, x.partNumber]));
  const siteCode = new Map(data.supplierSites.map((x) => [x.id, x.code]));
  const close = () => {
    setDialog(null);
    setF({});
  };
  const act = async (fn: () => Promise<unknown>, ok: string, after?: (r: unknown) => void) => {
    let result: unknown;
    if (
      await run(async () => {
        result = await fn();
      }, ok)
    ) {
      close();
      if (after) after(result);
      else reload();
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.lines);
  const addLine = (l: Omit<Line, 'siteIds' | 'productFamilies' | 'applicabilityNote' | 'action'> & Partial<Line>) =>
    setDraft((d) => [...(d ?? []), { siteIds: [], productFamilies: [], applicabilityNote: null, action: a.kind === 'AMENDMENT' ? 'REPLACE' : 'INCORPORATE', ...l } as Line]);
  const saveManifest = () =>
    act(
      () =>
        api(`/api/agreements/${id}/documents`, {
          method: 'PUT',
          body: {
            version: a.version,
            lines: draft.map((l) => ({
              role: l.role,
              action: l.action,
              documentRevisionId: l.documentRevisionId,
              baselineRevisionId: l.baselineRevisionId,
              fileId: l.fileId,
              precedence: Number(l.precedence) || null,
              contractualRef: l.contractualRef,
              siteIds: l.siteIds,
              partIds: l.partIds,
              productFamilies: l.productFamilies,
              applicabilityNote: l.applicabilityNote,
            })),
          },
        }),
      'Manifest saved',
    );
  const ordered = [...data.lines].sort((x, y) => x.precedence - y.precedence);
  const pdfAttachments = data.attachments.filter((x) => x.mime === 'application/pdf');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {a.number} <AgreementStateBadge state={a.state} />
          </h1>
          <div className="small muted">
            {a.kind === 'AMENDMENT' ? 'Amendment' : a.kind === 'RENEWAL' ? 'Renewal' : 'Supplier agreement'} for <Link to={`/suppliers/${data.supplier.id}#agreements`}>{data.supplier.legalName}</Link> ({data.supplier.code}) · {a.title}
          </div>
        </div>
        <div className="row-actions">
          <a className="btn" href={`/api/agreements/${id}/preview.pdf`} target="_blank" rel="noopener noreferrer">
            Preview package
          </a>
          {p.canSubmit && (
            <button type="button" className="btn btn-primary" disabled={busy || dirty} title={dirty ? 'Save the manifest first' : undefined} onClick={() => act(() => api(`/api/agreements/${id}/submit`, { body: { version: a.version } }), 'Submitted for internal review')}>
              Submit for review
            </button>
          )}
          {p.canApprove && (
            <button type="button" className="btn btn-primary" onClick={() => setDialog('approve')}>
              Approve for execution…
            </button>
          )}
          {p.canReturn && (
            <button type="button" className="btn" onClick={() => setDialog('return')}>
              Return to draft…
            </button>
          )}
          {p.canRecordExecution && (
            <button type="button" className="btn btn-primary" onClick={() => setDialog('execute')}>
              Record execution…
            </button>
          )}
          {p.canAmend && (
            <button type="button" className="btn" onClick={() => setDialog('amend')}>
              Amend…
            </button>
          )}
          {p.canCloseRevisionReview && (
            <button type="button" className="btn" onClick={() => setDialog('review')}>
              No amendment needed…
            </button>
          )}
          {p.canRenew && (
            <button type="button" className="btn" onClick={() => setDialog('renew')}>
              Renew…
            </button>
          )}
          {p.canCancel && (
            <button type="button" className="btn btn-danger" onClick={() => setDialog('cancel')}>
              Cancel…
            </button>
          )}
          {p.canTerminate && (
            <button type="button" className="btn btn-danger" onClick={() => setDialog('terminate')}>
              Terminate…
            </button>
          )}
        </div>
      </div>
      {banner}
      {p.approveBlockedReason && <div className="notice notice-warn">{String(p.approveBlockedReason)}</div>}
      {a.state === 'AWAITING_EXECUTION' && (
        <div className="notice notice-warn">Approved by PDI for execution. Approval is not execution: the agreement takes effect only when the signed copy is recorded.</div>
      )}
      {data.conflicts.map((c, i) => (
        <div key={i} className="notice notice-error" role="alert">
          <strong>Precedence conflict:</strong> {c.message}. The approver must record how it is resolved; TQM does not resolve it.
        </div>
      ))}
      {data.stale.map((s) => (
        <div key={s.lineId} className="notice notice-warn">
          {s.message}. {a.state === 'EXECUTED' ? 'The executed agreement is unchanged; amend it to incorporate the new revision.' : 'Update the manifest before submitting.'}
        </div>
      ))}

      <section className="card">
        <dl className="kv">
          <dt>Supplier legal entity</dt>
          <dd>{a.legalEntity}</dd>
          <dt>Sites covered</dt>
          <dd>{data.sites.map((s) => `${s.code} ${s.name}`).join('; ')}</dd>
          <dt>Product families</dt>
          <dd>{a.productFamilies.join(', ') || 'Not restricted'}</dd>
          <dt>Effective</dt>
          <dd>{fmtDate(a.effectiveFrom) || 'Set when execution is recorded'}</dd>
          <dt>Expires</dt>
          <dd>{fmtDate(a.expiresOn) || 'None stated'}</dd>
          {a.changeSummary && (
            <>
              <dt>Change summary</dt>
              <dd>{a.changeSummary}</dd>
            </>
          )}
          {a.exceptions && (
            <>
              <dt>Exceptions</dt>
              <dd>{a.exceptions}</dd>
            </>
          )}
          <dt>Prepared</dt>
          <dd>
            {a.preparedByName}, {fmtDateTime(a.createdAt)}
          </dd>
          {a.approvedByName && (
            <>
              <dt>PDI approval</dt>
              <dd>
                {a.approvedByName}, {fmtDateTime(a.approvedAt)}
              </dd>
            </>
          )}
          {a.manifestSha256 && (
            <>
              <dt>Manifest SHA-256</dt>
              <dd style={{ wordBreak: 'break-all' }}>{a.manifestSha256}</dd>
            </>
          )}
          {a.conflictResolution && (
            <>
              <dt>Conflict resolution</dt>
              <dd>{a.conflictResolution}</dd>
            </>
          )}
          {a.terminationReason && (
            <>
              <dt>Terminated</dt>
              <dd>
                {fmtDateTime(a.terminatedAt)}: {a.terminationReason}
              </dd>
            </>
          )}
          {a.cancelReason && (
            <>
              <dt>Cancelled</dt>
              <dd>
                {fmtDateTime(a.cancelledAt)}: {a.cancelReason}
              </dd>
            </>
          )}
        </dl>
        {p.canEdit && (
          <button type="button" className="btn btn-small" style={{ marginTop: 8 }} onClick={() => setDialog('terms')}>
            Edit terms…
          </button>
        )}
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>{p.canEdit ? 'Manifest (draft)' : 'Manifest'}</h2>
          {p.canEdit && (
            <div className="row-actions">
              <button type="button" className="btn btn-small btn-primary" disabled={busy || !dirty} onClick={saveManifest}>
                Save manifest
              </button>
            </div>
          )}
        </div>
        <p className="small muted">Each line binds one exact revision. Lower precedence governs. Leave sites, parts and families empty to apply to the whole agreement scope.</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Document</th>
                <th>Role</th>
                {a.kind === 'AMENDMENT' && <th>Action</th>}
                <th>Precedence</th>
                <th>Reference</th>
                <th>Applies to</th>
                {p.canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {(p.canEdit ? draft : ordered).length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">No documents yet.</div>
                  </td>
                </tr>
              )}
              {(p.canEdit ? draft : ordered).map((l, i) => {
                const set = (patch: Partial<Line>) => setDraft((d) => d!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <tr key={l.id ?? `new-${i}`}>
                    <td>
                      {l.documentId ? <Link to={`/documents/${l.documentId}`}>{l.documentNumber}</Link> : l.baselineRevisionId ? <Link to={`/baselines/${l.baselineRevisionId}`}>{l.documentNumber}</Link> : l.documentNumber} Rev {l.revisionLabel}
                      <div className="small muted">{l.title}</div>
                      {l.sha256 && <div className="small muted">SHA-256 {l.sha256.slice(0, 16)}…</div>}
                    </td>
                    <td className="small">{ROLE_TEXT[l.role]}</td>
                    {a.kind === 'AMENDMENT' && (
                      <td>
                        {p.canEdit ? (
                          <select aria-label={`Action for ${l.documentNumber}`} value={l.action} onChange={(e) => set({ action: e.target.value as Line['action'] })}>
                            <option value="INCORPORATE">Add</option>
                            <option value="REPLACE">Replace</option>
                            <option value="REMOVE">Remove</option>
                          </select>
                        ) : (
                          <span className="small">{l.action.toLowerCase()}</span>
                        )}
                      </td>
                    )}
                    <td>
                      {p.canEdit ? <input aria-label={`Precedence of ${l.documentNumber}`} type="number" min={1} max={999} style={{ width: 70 }} value={l.precedence} onChange={(e) => set({ precedence: Number(e.target.value) })} /> : l.precedence}
                    </td>
                    <td>{p.canEdit ? <input aria-label={`Contractual reference of ${l.documentNumber}`} style={{ width: 110 }} value={l.contractualRef} onChange={(e) => set({ contractualRef: e.target.value })} /> : l.contractualRef}</td>
                    <td className="small">
                      {p.canEdit ? (
                        <>
                          <select multiple aria-label={`Sites for ${l.documentNumber}`} value={l.siteIds} onChange={(e) => set({ siteIds: [...e.target.selectedOptions].map((o) => o.value) })} style={{ minWidth: 90 }}>
                            {data.sites.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.code}
                              </option>
                            ))}
                          </select>
                          <input aria-label={`Product families for ${l.documentNumber}`} placeholder="Families" style={{ width: 120, display: 'block', marginTop: 4 }} value={l.productFamilies.join(', ')} onChange={(e) => set({ productFamilies: words(e.target.value) })} />
                          {l.partIds.length > 0 && (
                            <div>
                              Parts {l.partIds.map((x) => partNo.get(x) ?? 'part').join(', ')}{' '}
                              {l.role !== 'PART_SCHEDULE' && (
                                <button type="button" className="btn-link" onClick={() => set({ partIds: [] })}>
                                  clear
                                </button>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        [l.siteIds.length ? `Sites ${l.siteIds.map((x) => siteCode.get(x) ?? x).join(', ')}` : 'All covered sites', l.partIds.length ? `Parts ${l.partIds.map((x) => partNo.get(x) ?? x).join(', ')}` : null, l.productFamilies.length ? `Families ${l.productFamilies.join(', ')}` : null]
                          .filter(Boolean)
                          .join('; ')
                      )}
                    </td>
                    {p.canEdit && (
                      <td>
                        <button type="button" className="btn btn-small" aria-label={`Remove ${l.documentNumber}`} onClick={() => setDraft((d) => d!.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.canEdit && (
          <>
            <h3>Recommended for this supplier's sites</h3>
            <LoadState loading={recs.loading && !recs.data} error={recs.error} />
            <ul className="small">
              {(recs.data ?? []).map((r) => {
                const inDraft = draft.some((l) => (r.documentRevisionId && l.documentRevisionId === r.documentRevisionId) || (r.baselineRevisionId && l.baselineRevisionId === r.baselineRevisionId));
                return (
                  <li key={r.documentRevisionId ?? r.baselineRevisionId}>
                    <strong>
                      {r.documentNumber} Rev {r.revisionLabel}
                    </strong>{' '}
                    {r.title} <span className="muted">— {ROLE_TEXT[r.role]}; {r.reason}</span>{' '}
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={inDraft}
                      onClick={() =>
                        addLine({
                          role: r.role,
                          documentRevisionId: r.documentRevisionId ?? null,
                          baselineRevisionId: r.baselineRevisionId ?? null,
                          fileId: null,
                          documentNumber: r.documentNumber,
                          title: r.title,
                          revisionLabel: r.revisionLabel,
                          precedence: r.precedence,
                          contractualRef: r.contractualRef,
                          partIds: r.partIds,
                        })
                      }
                    >
                      {inDraft ? 'Included' : 'Add'}
                    </button>
                  </li>
                );
              })}
              {recs.data?.length === 0 && <li className="muted">No recommendations: classify the master agreement and specifications in the Document Library.</li>}
            </ul>
            <div className="row-actions">
              <label htmlFor="add-doc" className="small">
                Add another classified document
              </label>
              <select
                id="add-doc"
                value=""
                onChange={(e) => {
                  const d = specs.data?.find((x) => x.documentId === e.target.value);
                  if (d?.current) addLine({ role: ROLE_OF_CLASS[d.classification]!, documentRevisionId: d.current.id, baselineRevisionId: null, fileId: null, documentNumber: d.number, title: d.title, revisionLabel: d.current.revisionLabel, precedence: d.defaultPrecedence, contractualRef: '', partIds: [] });
                }}
              >
                <option value="">Choose…</option>
                {(specs.data ?? [])
                  .filter((d) => d.current)
                  .map((d) => (
                    <option key={d.documentId} value={d.documentId}>
                      {d.number} Rev {d.current!.revisionLabel} — {CLASSIFICATION_TEXT[d.classification]}
                    </option>
                  ))}
              </select>
              {pdfAttachments.length > 0 && (
                <select
                  aria-label="Add an attached file as an exhibit"
                  value=""
                  onChange={(e) => {
                    const x = pdfAttachments.find((y) => y.fileId === e.target.value);
                    if (x) addLine({ role: 'EXHIBIT', documentRevisionId: null, baselineRevisionId: null, fileId: x.fileId, documentNumber: 'Exhibit', title: x.name ?? 'Exhibit', revisionLabel: '-', precedence: 90, contractualRef: 'Exhibit', partIds: [] });
                  }}
                >
                  <option value="">Add attached file as exhibit…</option>
                  {pdfAttachments.map((x) => (
                    <option key={x.fileId} value={x.fileId}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </>
        )}
      </section>

      {(a.kind === 'AMENDMENT' || a.state === 'EXECUTED') && data.effective.length > 0 && (
        <section className="card">
          <h2>{a.kind === 'AMENDMENT' ? 'Resulting documents once executed' : 'Documents in effect (with executed amendments)'}</h2>
          <ul className="small">
            {[...data.effective]
              .sort((x, y) => x.precedence - y.precedence)
              .map((l) => (
                <li key={l.id}>
                  {l.documentNumber} Rev {l.revisionLabel} — {ROLE_TEXT[l.role]} ({l.contractualRef})
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Package, signatures and documents</h2>
          {p.canAttach && <UploadEvidence entityType="SUPPLIER_AGREEMENT" entityId={id} label="+ Attach document" onUploaded={reload} />}
        </div>
        <h3>Generated package</h3>
        {data.renditions.length === 0 ? (
          <p className="small muted">The package PDF is generated at PDI approval and again when execution is recorded. Use Preview package to review a draft.</p>
        ) : (
          <ul className="small">
            {data.renditions.map((r) => (
              <li key={r.edition}>
                Edition {r.edition} ({r.stage.toLowerCase()}, {fmtDateTime(r.createdAt)}){' '}
                {r.fileId ? (
                  <>
                    <a href={`/api/files/${r.fileId}`} target="_blank" rel="noopener noreferrer">
                      Open PDF
                    </a>{' '}
                    · {r.pageCount} pages · {r.validated ? 'validated: originals appended unaltered' : 'validation pending'}
                  </>
                ) : (
                  <span className="muted">rendering…</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <h3>Approval and execution record</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Role</th>
                <th>Name</th>
                <th>Date</th>
                <th>Reference</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {data.signatures.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No approval or execution recorded yet.</div>
                  </td>
                </tr>
              )}
              {data.signatures.map((s) => (
                <tr key={s.id}>
                  <td className="small">
                    {SIGNATURE_TEXT[s.role]}
                    {s.cycle > 1 && <span className="muted"> (cycle {s.cycle})</span>}
                  </td>
                  <td className="small">
                    {s.signerName}
                    {s.signerTitle && `, ${s.signerTitle}`}
                  </td>
                  <td className="small">{fmtDate(s.signedOn)}</td>
                  <td className="small" style={{ wordBreak: 'break-all' }}>
                    {s.reference ?? '—'}
                  </td>
                  <td className="small">
                    {s.recordedBy}
                    {s.mode === 'EXTERNAL' && <div className="muted">attested from the signed copy</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Attached documents</h3>
        <FileLinks files={data.attachments} canRemove={!!p.canAttach} onChanged={reload} />
        {a.executedFileId && (
          <p className="small">
            Signed agreement:{' '}
            <a href={`/api/files/${a.executedFileId}`} target="_blank" rel="noopener noreferrer">
              open signed copy
            </a>
          </p>
        )}
      </section>

      <section className="card">
        <h2>Related agreements</h2>
        {data.related.filter((r) => r.id !== id).length === 0 ? (
          <p className="small muted">None.</p>
        ) : (
          <ul className="small">
            {data.related
              .filter((r) => r.id !== id)
              .map((r) => (
                <li key={r.id}>
                  <Link to={`/agreements/${r.id}`}>{r.number}</Link> {r.kind.toLowerCase()} — {r.title} <AgreementStateBadge state={r.state} />
                  {r.id === a.parentId && <span className="muted"> (parent)</span>}
                  {r.id === a.supersededById && <span className="muted"> (supersedes this agreement)</span>}
                </li>
              ))}
          </ul>
        )}
        {data.work.length > 0 && (
          <>
            <h3>Work items</h3>
            <ul className="small">
              {data.work.map((w) => (
                <li key={w.id}>
                  {w.title} <span className="muted">({w.status.toLowerCase()}, {fmtDateTime(w.createdAt)})</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2>History</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((e) => (
                <tr key={e.id}>
                  <td className="small">{fmtDateTime(e.occurredAt)}</td>
                  <td className="small">{e.actor ?? 'System'}</td>
                  <td className="small">
                    {e.outcome !== 'SUCCESS' && <span className="badge badge-fail">{e.outcome.toLowerCase()}</span>} {e.summary}
                    {e.reason && <div className="muted">{e.reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog
        open={dialog === 'approve'}
        title={`Approve ${a.number} for execution`}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.legalReviewer || !f.legalReference || !f.legalReviewedOn || (data.conflicts.length > 0 && !f.conflictResolution)}
              onClick={() =>
                act(
                  () =>
                    api(`/api/agreements/${id}/approve`, {
                      body: { version: a.version, legalReviewer: f.legalReviewer, legalReference: f.legalReference, legalReviewedOn: f.legalReviewedOn, conflictResolution: f.conflictResolution || null, statement: f.statement || null },
                    }),
                  'Approved for execution; the manifest is frozen and the package PDF is being generated',
                )
              }
            >
              Approve
            </button>
          </>
        }
      >
        <p className="small muted">PDI internal approval freezes the manifest. It is not execution. Record the legal review that cleared the contractual documents.</p>
        <div className="field">
          <label htmlFor="ap-lr">Legal reviewer</label>
          <input id="ap-lr" {...field('legalReviewer')} />
        </div>
        <div className="field">
          <label htmlFor="ap-ref">Legal review reference</label>
          <input id="ap-ref" {...field('legalReference')} />
        </div>
        <div className="field">
          <label htmlFor="ap-date">Legal review date</label>
          <input id="ap-date" type="date" {...field('legalReviewedOn')} />
        </div>
        {data.conflicts.length > 0 && (
          <div className="field">
            <label htmlFor="ap-conf">How the {data.conflicts.length} precedence conflict(s) are resolved</label>
            <textarea id="ap-conf" rows={3} {...field('conflictResolution')} />
          </div>
        )}
        <div className="field">
          <label htmlFor="ap-st">Approval statement (optional)</label>
          <input id="ap-st" {...field('statement')} />
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'execute'}
        title={`Record execution of ${a.number}`}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.signedFileId || !f.effectiveFrom || !f.pdiName || !f.pdiTitle || !f.pdiOn || !f.supName || !f.supTitle || !f.supOn}
              onClick={() =>
                act(
                  () =>
                    api(`/api/agreements/${id}/execution`, {
                      body: {
                        version: a.version,
                        signedFileId: f.signedFileId,
                        effectiveFrom: f.effectiveFrom,
                        pdiSignatory: { name: f.pdiName, title: f.pdiTitle, signedOn: f.pdiOn },
                        supplierSignatory: { name: f.supName, title: f.supTitle, signedOn: f.supOn },
                        note: f.note || null,
                      },
                    }),
                  'Execution recorded',
                )
              }
            >
              Record execution
            </button>
          </>
        }
      >
        <p className="small muted">Record what the signed agreement shows. TQM attests the signatures from the signed copy; it does not apply an electronic signature.</p>
        <div className="field">
          <label htmlFor="ex-file">Signed agreement (PDF attached to this record)</label>
          <select id="ex-file" {...field('signedFileId')}>
            <option value="">Choose…</option>
            {pdfAttachments.map((x) => (
              <option key={x.fileId} value={x.fileId}>
                {x.name} ({fmtDateTime(x.linkedAt)})
              </option>
            ))}
          </select>
          {pdfAttachments.length === 0 && <span className="field-hint">Attach the signed PDF first (Package, signatures and documents).</span>}
        </div>
        <div className="field">
          <label htmlFor="ex-eff">Effective date</label>
          <input id="ex-eff" type="date" {...field('effectiveFrom')} />
        </div>
        <fieldset className="field">
          <legend>Authorized PDI signatory</legend>
          <label htmlFor="ex-pn">Name</label>
          <input id="ex-pn" {...field('pdiName')} />
          <label htmlFor="ex-pt">Title</label>
          <input id="ex-pt" {...field('pdiTitle')} />
          <label htmlFor="ex-pd">Signed on</label>
          <input id="ex-pd" type="date" {...field('pdiOn')} />
        </fieldset>
        <fieldset className="field">
          <legend>Supplier authorized signatory</legend>
          <label htmlFor="ex-sn">Name</label>
          <input id="ex-sn" {...field('supName')} />
          <label htmlFor="ex-st">Title</label>
          <input id="ex-st" {...field('supTitle')} />
          <label htmlFor="ex-sd">Signed on</label>
          <input id="ex-sd" type="date" {...field('supOn')} />
        </fieldset>
        <div className="field">
          <label htmlFor="ex-note">Note (optional)</label>
          <input id="ex-note" {...field('note')} />
        </div>
      </Dialog>

      <ReasonDialog open={dialog === 'return'} title="Return to draft" label="What must change" busy={busy} onClose={close} onSubmit={(reason) => act(() => api(`/api/agreements/${id}/return`, { body: { reason } }), 'Returned to draft')} />
      <ReasonDialog
        open={dialog === 'review'}
        title="Close the revision review without amending"
        label="Why the executed agreement stays on its current revisions"
        busy={busy}
        onClose={close}
        onSubmit={(reason) => act(() => api(`/api/agreements/${id}/revision-review`, { body: { reason } }), 'Revision review closed; the agreement is unchanged')}
      />
      <ReasonDialog open={dialog === 'cancel'} title={`Cancel ${a.number}`} label="Reason for cancelling" busy={busy} onClose={close} onSubmit={(reason) => act(() => api(`/api/agreements/${id}/cancel`, { body: { reason } }), 'Cancelled')} />
      <ReasonDialog open={dialog === 'terminate'} title={`Terminate ${a.number}`} label="Reason for termination" busy={busy} onClose={close} onSubmit={(reason) => act(() => api(`/api/agreements/${id}/terminate`, { body: { reason } }), 'Terminated; history retained')} />
      <ReasonDialog
        open={dialog === 'amend'}
        title={`Amend ${a.number}`}
        label="What the amendment changes"
        busy={busy}
        onClose={close}
        onSubmit={(changeSummary) => act(() => api<{ id: string }>(`/api/agreements/${id}/amendments`, { body: { changeSummary } }), 'Amendment drafted', (r) => navigate(`/agreements/${(r as { id: string }).id}`))}
      />

      <Dialog
        open={dialog === 'renew'}
        title={`Renew ${a.number}`}
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => api<{ id: string }>(`/api/agreements/${id}/renewal`, { body: { expiresOn: f.expiresOn || null } }), 'Renewal drafted', (r) => navigate(`/agreements/${(r as { id: string }).id}`))}>
              Draft renewal
            </button>
          </>
        }
      >
        <p className="small muted">The renewal carries the documents in effect forward at the revisions now in force. When executed, it supersedes this agreement and its amendments.</p>
        <div className="field">
          <label htmlFor="rn-exp">New expiry date (optional)</label>
          <input id="rn-exp" type="date" {...field('expiresOn')} />
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'terms'}
        title="Edit draft terms"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                act(
                  () =>
                    api(`/api/agreements/${id}`, {
                      method: 'PATCH',
                      body: {
                        version: a.version,
                        title: f.title ?? a.title,
                        productFamilies: words(f.families ?? a.productFamilies.join(', ')),
                        expiresOn: (f.expiresOn ?? a.expiresOn) || null,
                        exceptions: (f.exceptions ?? a.exceptions) || null,
                        changeSummary: (f.changeSummary ?? a.changeSummary) || null,
                      },
                    }),
                  'Draft updated',
                )
              }
            >
              Save
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="tm-title">Title</label>
          <input id="tm-title" value={f.title ?? a.title} onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="tm-fam">Product families (comma separated)</label>
          <input id="tm-fam" value={f.families ?? a.productFamilies.join(', ')} onChange={(e) => setF((x) => ({ ...x, families: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="tm-exp">Expiry date</label>
          <input id="tm-exp" type="date" value={f.expiresOn ?? a.expiresOn ?? ''} onChange={(e) => setF((x) => ({ ...x, expiresOn: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="tm-exc">Exceptions</label>
          <textarea id="tm-exc" rows={2} value={f.exceptions ?? a.exceptions ?? ''} onChange={(e) => setF((x) => ({ ...x, exceptions: e.target.value }))} />
        </div>
        {a.kind === 'AMENDMENT' && (
          <div className="field">
            <label htmlFor="tm-chg">Change summary</label>
            <textarea id="tm-chg" rows={2} value={f.changeSummary ?? a.changeSummary ?? ''} onChange={(e) => setF((x) => ({ ...x, changeSummary: e.target.value }))} />
          </div>
        )}
      </Dialog>
    </>
  );
}

function ReasonDialog({ open, title, label, busy, onClose, onSubmit }: { open: boolean; title: string; label: string; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={open}
      title={title}
      onClose={() => {
        setReason('');
        onClose();
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={() => onSubmit(reason.trim())}>
            Confirm
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="reason-text">{label}</label>
        <textarea id="reason-text" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}
