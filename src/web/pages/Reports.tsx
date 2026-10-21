import { useEffect, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router-dom';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { ColumnChart, PeriodFilter, VIZ, pctText } from '../components/charts';
import { type Rendition, StateBadge } from '../components/quality';
import { useBusy } from '../components/sourcing';
import { LoadState, OutcomeBadge, type PartOption, PartTypeahead, StatusBadge, useLoad } from '../components/ui';

function ReportTabs() {
  const cls = ({ isActive }: { isActive: boolean }) => `btn btn-small${isActive ? ' btn-primary' : ''}`;
  return (
    <div className="row-actions" role="navigation" aria-label="Report sections" style={{ marginBottom: 12 }}>
      <NavLink to="/reports" end className={cls}>
        Management overview
      </NavLink>
      <NavLink to="/trace" className={cls}>
        Traceability
      </NavLink>
    </div>
  );
}

interface Ratio {
  pass: number;
  of: number;
  percent: number | null;
}

interface Overview {
  period: { from: string; to: string; timeZone: string };
  generatedAt: string;
  definitionsVersion: string;
  definitions: Record<string, string[]>;
  horizon: { days: number; until: string };
  inspections: {
    completed: number;
    started: number;
    outcomes: { PASS: number; FAIL: number; ACCEPTED: number };
    failRate: number | null;
    weekly: Array<{ week: string; pass: number; fail: number; accepted: number }>;
    defects: Array<{ section_key: string; row_key: string; name: string; section: string; fail: number; accepted: number; inspections: number; parts: string[] }>;
    links: Record<'completed' | 'PASS' | 'FAIL' | 'ACCEPTED', string>;
  };
  suppliers: Array<{ id: string; code: string; name: string; completed: number; failed: number; accepted: number; failRate: number | null; ncrs: number; openNcrs: number; openScars: number; overdueCommitments: number; sites: string[]; link: string; inspectionsLink: string }>;
  corrective: {
    counts: Record<string, number>;
    ncrsConfirmed: number;
    ncrsClosed: number;
    ncrBySeverity: Array<{ severity: string; status: string; n: number }>;
    overdue: Array<{ type: string; id: string; number: string; title: string; due: string; owner: string; link: string }>;
  };
  qualification: { sites: number; byStatus: Record<string, number>; expiring: Array<{ type: string; label: string; supplier: string; valid_until: string; expired: boolean; link: string }> };
  changes: { byStatus: Array<{ status: string; n: number }>; requested: number; decided: number };
  approvals: Array<{ type: string; number: string; decision: string; decided_at: string; decided_by: string; subject: string; link: string }>;
  recurrence: {
    groups: Array<{ part_number: string | null; supplier: string | null; characteristic: string; failure_mode: string; ncrs: Array<{ id: string; number: string }>; link: string | null }>;
    faiRepeats: Array<{ ncr_number: string; characteristic: string; fai_number: string; lot_number: string | null; link: string; faiLink: string }>;
  };
  injectors: { tests: number; injectors: number; retests: number; firstPassYield: { machine: Ratio; pdi: Ratio }; postRepairYield: { tests: number; machine: Ratio; pdi: Ratio }; definitions: string[] };
}

const words = (s: string) => s.replaceAll('_', ' ').toLowerCase();

function Metric({ value, label, to }: { value: string | number; label: string; to?: string }) {
  const body = (
    <>
      <strong>{value}</strong>
      <span className="small">{label}</span>
    </>
  );
  return to ? (
    <Link className="metric" to={to} role="listitem">
      {body}
    </Link>
  ) : (
    <div className="metric" role="listitem">
      {body}
    </div>
  );
}

function IssuedReports({ refreshKey }: { refreshKey: number }) {
  const { data, reload } = useLoad<Array<{ id: string; number: string; periodFrom: string; periodTo: string; definitionsVersion: string; issuedAt: string; issuedBy: string; renditions: Rendition[] }>>('/api/reports/issued', [refreshKey]);
  useEffect(() => {
    if (data?.some((r) => r.renditions.some((x) => !x.fileId))) {
      const t = setTimeout(reload, 1500);
      return () => clearTimeout(t);
    }
  }, [data, reload]);
  if (!data?.length) return null;
  return (
    <section className="card" aria-labelledby="issued-h">
      <h2 id="issued-h">Issued management reports</h2>
      <ul className="small">
        {data.map((r) => (
          <li key={r.id}>
            {r.number} — {fmtDate(r.periodFrom)} to {fmtDate(r.periodTo)} ({r.definitionsVersion}), {r.issuedBy}, {fmtDateTime(r.issuedAt)}{' '}
            {r.renditions.map((x) =>
              x.fileId ? (
                <a key={x.edition} href={`/api/files/${x.fileId}`} target="_blank" rel="noopener noreferrer">
                  PDF
                </a>
              ) : (
                <span key={x.edition} className="muted">
                  rendering…
                </span>
              ),
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Reports() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const qs = new URLSearchParams();
  for (const k of ['from', 'to']) if (params.get(k)) qs.set(k, params.get(k)!);
  const { data, error, loading } = useLoad<Overview>(`/api/reports/overview?${qs.toString()}`);
  const { busy, run, banner } = useBusy();
  const [issued, setIssued] = useState(0);
  const period = data ? `from=${data.period.from}&to=${data.period.to}` : '';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <div className="muted small">Every figure links to the records behind it. Period figures use whole dates in the display time zone; “now” figures describe records as they are.</div>
        </div>
        {data && can('reports.export') && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api('/api/reports/issue', { body: { from: data.period.from, to: data.period.to } });
                setIssued((n) => n + 1);
              }, 'Management report issued; the PDF appears below when rendered.')
            }
          >
            Issue management report PDF
          </button>
        )}
      </div>
      <ReportTabs />
      {banner}
      <div className="card">
        <PeriodFilter from={data?.period.from ?? params.get('from') ?? ''} to={data?.period.to ?? params.get('to') ?? ''} onChange={(from, to) => setParams({ from, to })} />
        {data && (
          <div className="small muted" style={{ marginTop: 6 }}>
            {fmtDate(data.period.from)} – {fmtDate(data.period.to)} ({data.period.timeZone}) · definitions {data.definitionsVersion} · generated {fmtDateTime(data.generatedAt)}
          </div>
        )}
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <>
          <section className="card" aria-labelledby="insp-h">
            <h2 id="insp-h">Inspection throughput and outcomes</h2>
            <div className="metric-grid" role="list">
              <Metric value={data.inspections.started} label="started in period" />
              <Metric value={data.inspections.completed} label="completed in period" to={data.inspections.links.completed} />
              <Metric value={data.inspections.outcomes.PASS} label="✓ pass" to={data.inspections.links.PASS} />
              <Metric value={data.inspections.outcomes.ACCEPTED} label="! accepted with deviation" to={data.inspections.links.ACCEPTED} />
              <Metric value={data.inspections.outcomes.FAIL} label={`✗ fail (${data.inspections.failRate ?? 'n/a'}${data.inspections.failRate === null ? '' : '%'} of completed)`} to={data.inspections.links.FAIL} />
              <Metric value={data.corrective.counts.awaiting_review ?? 0} label="awaiting review now" to="/inspections?status=READY_FOR_REVIEW" />
            </div>
            <div className="two-col">
              <ColumnChart
                title="Completed inspections per week, by outcome"
                categories={data.inspections.weekly.map((w) => w.week)}
                series={[
                  { key: 'pass', label: '✓ Pass', color: VIZ.good, values: data.inspections.weekly.map((w) => w.pass) },
                  { key: 'accepted', label: '! Accepted', color: VIZ.warning, values: data.inspections.weekly.map((w) => w.accepted) },
                  { key: 'fail', label: '✗ Fail', color: VIZ.critical, values: data.inspections.weekly.map((w) => w.fail) },
                ]}
                formatCategory={(w) => `wk ${fmtDate(w).slice(0, 5)}`}
              />
              <div>
                <div className="viz-title">Defect types (flagged checklist rows)</div>
                {data.inspections.defects.length === 0 ? (
                  <p className="muted small">No failed or accepted rows in the period.</p>
                ) : (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Fail</th>
                        <th>Accepted</th>
                        <th>Inspections</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.inspections.defects.map((d) => (
                        <tr key={`${d.section_key}|${d.row_key}`}>
                          <td>
                            {d.name}
                            <div className="small muted">
                              {d.section} · {d.parts.join(', ')}
                            </div>
                          </td>
                          <td>{d.fail}</td>
                          <td>{d.accepted}</td>
                          <td>{d.inspections}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            {can('reports.export') && (
              <div className="row-actions small" style={{ marginTop: 8 }}>
                <a className="btn btn-small" href={`/api/exports/inspections.csv?${period}`}>
                  Inspections CSV
                </a>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="sup-h">
            <h2 id="sup-h">Supplier quality</h2>
            {data.suppliers.length === 0 ? (
              <p className="muted small">No supplier activity in the period.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th>Completed</th>
                      <th>Fail (rate)</th>
                      <th>NCRs in period</th>
                      <th>Open NCR / SCAR</th>
                      <th>Overdue commitments</th>
                      <th>Site qualification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.suppliers.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link to={s.link}>{s.name}</Link>
                          <div className="small muted">{s.code}</div>
                        </td>
                        <td>
                          <Link to={s.inspectionsLink}>{s.completed}</Link>
                        </td>
                        <td>
                          {s.failed} ({s.failRate ?? 'n/a'}
                          {s.failRate === null ? '' : '%'})
                        </td>
                        <td>{s.ncrs}</td>
                        <td>
                          {s.openNcrs} / {s.openScars}
                        </td>
                        <td>{s.overdueCommitments}</td>
                        <td className="small">{s.sites.map(words).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {can('reports.export') && (
              <div className="row-actions small" style={{ marginTop: 8 }}>
                <a className="btn btn-small" href={`/api/exports/supplier-quality.csv?${period}`}>
                  Supplier quality CSV
                </a>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="ca-h">
            <h2 id="ca-h">Corrective actions</h2>
            <div className="metric-grid" role="list">
              <Metric value={data.corrective.ncrsConfirmed} label="NCRs confirmed in period" />
              <Metric value={data.corrective.ncrsClosed} label="NCRs closed in period" />
              <Metric value={data.corrective.counts.open_ncrs ?? 0} label="open NCRs now" to="/quality/ncrs" />
              <Metric value={`${data.corrective.counts.open_scars ?? 0} / ${data.corrective.counts.overdue_scars ?? 0}`} label="open SCARs / response overdue" to="/quality/scars" />
              <Metric value={`${data.corrective.counts.open_commitments ?? 0} / ${data.corrective.counts.overdue_commitments ?? 0}`} label="open commitments / overdue" to="/commitments?view=OVERDUE" />
              <Metric value={data.corrective.counts.undated_commitments ?? 0} label="commitments without a date" to="/commitments" />
            </div>
            {data.corrective.overdue.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Overdue</th>
                      <th>Subject</th>
                      <th>Due</th>
                      <th>Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.corrective.overdue.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link to={o.link}>{o.number}</Link> <span className="small muted">{o.type}</span>
                        </td>
                        <td>{o.title}</td>
                        <td>
                          {fmtDate(o.due)} <span className="badge badge-fail">overdue</span>
                        </td>
                        <td className="small">{o.owner}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {can('reports.export') && (
              <div className="row-actions small" style={{ marginTop: 8 }}>
                {[
                  ['ncrs', 'NCRs'],
                  ['scars', 'SCARs'],
                  ['commitments', 'Commitments'],
                ].map(([n, label]) => (
                  <a key={n} className="btn btn-small" href={`/api/exports/${n}.csv?${period}`}>
                    {label} CSV
                  </a>
                ))}
              </div>
            )}
          </section>

          <div className="two-col">
            <section className="card" aria-labelledby="q-h">
              <h2 id="q-h">Qualification and expiring evidence</h2>
              <p className="small">
                {data.qualification.sites} site(s):{' '}
                {Object.entries(data.qualification.byStatus)
                  .map(([k, v]) => `${words(k)} ${v}`)
                  .join(', ') || 'none'}
              </p>
              <div className="small muted">
                Expired or expiring by {fmtDate(data.horizon.until)} ({data.horizon.days}-day reporting window, not a policy limit)
              </div>
              {data.qualification.expiring.length === 0 ? (
                <p className="muted small">Nothing expiring.</p>
              ) : (
                <ul className="small">
                  {data.qualification.expiring.map((e, i) => (
                    <li key={i}>
                      <Link to={e.link}>{e.supplier}</Link> — {e.type} {e.label}: {fmtDate(e.valid_until)} {e.expired && <span className="badge badge-fail">expired</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card" aria-labelledby="ch-h">
              <h2 id="ch-h">Changes</h2>
              <p className="small">
                {data.changes.requested} requested and {data.changes.decided} decided in the period.
              </p>
              <ul className="small">
                {data.changes.byStatus.map((c) => (
                  <li key={c.status}>
                    {words(c.status)}: {c.n}
                  </li>
                ))}
                {data.changes.byStatus.length === 0 && <li className="muted">No changes recorded.</li>}
              </ul>
              <Link className="small" to="/changes">
                All changes
              </Link>
            </section>
          </div>

          <section className="card" aria-labelledby="rec-h">
            <h2 id="rec-h">Recurrence</h2>
            {data.recurrence.groups.length === 0 && data.recurrence.faiRepeats.length === 0 && <p className="muted small">No recurrence in the period.</p>}
            {data.recurrence.faiRepeats.length > 0 && (
              <div className="notice notice-warn small">
                <strong>Repeats a defect found on a rejected first article:</strong>
                <ul style={{ margin: '4px 0 0' }}>
                  {data.recurrence.faiRepeats.map((f, i) => (
                    <li key={i}>
                      <Link to={f.link}>{f.ncr_number}</Link>
                      {f.lot_number ? ` (lot ${f.lot_number})` : ''} — {f.characteristic}, as on <Link to={f.faiLink}>{f.fai_number}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.recurrence.groups.length > 0 && (
              <table className="data">
                <thead>
                  <tr>
                    <th>Part / supplier</th>
                    <th>Characteristic / failure mode</th>
                    <th>NCRs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recurrence.groups.map((g, i) => (
                    <tr key={i}>
                      <td>
                        {g.part_number ?? '—'} / {g.link ? <Link to={g.link}>{g.supplier}</Link> : (g.supplier ?? '—')}
                      </td>
                      <td>
                        {g.characteristic || '—'} / {g.failure_mode || '—'}
                      </td>
                      <td>
                        {g.ncrs.map((n, k) => (
                          <span key={n.id}>
                            {k > 0 && ', '}
                            <Link to={`/quality/ncrs/${n.id}`}>{n.number}</Link>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <div className="two-col">
            <section className="card" aria-labelledby="ap-h">
              <h2 id="ap-h">Approval decisions in period</h2>
              {data.approvals.length === 0 ? (
                <p className="muted small">No approval decisions in the period.</p>
              ) : (
                <ul className="small">
                  {data.approvals.slice(0, 30).map((a, i) => (
                    <li key={i}>
                      {fmtDate(a.decided_at)} {a.type} <Link to={a.link}>{a.number}</Link> {words(a.decision)} — {a.subject} ({a.decided_by})
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card" aria-labelledby="inj-h">
              <h2 id="inj-h">Injector test and repair</h2>
              <div className="metric-grid" role="list">
                <Metric value={data.injectors.tests} label={`bench tests, ${data.injectors.retests} retests`} to={`/injectors/analytics?${period}`} />
                <Metric value={pctText(data.injectors.firstPassYield.pdi)} label={`first-pass, PDI (${data.injectors.firstPassYield.pdi.pass}/${data.injectors.firstPassYield.pdi.of})`} />
                <Metric value={pctText(data.injectors.firstPassYield.machine)} label={`first-pass, machine (${data.injectors.firstPassYield.machine.pass}/${data.injectors.firstPassYield.machine.of})`} />
                <Metric value={pctText(data.injectors.postRepairYield.pdi)} label={`post-repair, PDI (${data.injectors.postRepairYield.pdi.pass}/${data.injectors.postRepairYield.pdi.of})`} />
              </div>
            </section>
          </div>

          <details className="card small">
            <summary>Calculation definitions ({data.definitionsVersion})</summary>
            {Object.entries(data.definitions).map(([k, v]) => (
              <div key={k}>
                <strong>{k}</strong>
                <ul>
                  {v.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ))}
            <strong>injectors</strong>
            <ul>
              {data.injectors.definitions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
          <IssuedReports refreshKey={issued} />
        </>
      )}
    </>
  );
}

interface TraceData {
  query: { partId: string | null; lot: string | null; serial: string | null; date: string; timeZone: string };
  parts: Array<{ id: string; part_number: string; description: string }>;
  appliedOn: {
    date: string;
    baselines: Array<{ title: string; revision_label: string; status: string; released_at: string; effective_from: string | null; part_number: string; link: string }>;
    sources: Array<{ id: string; part_number: string; supplier: string; site: string; configuration: string; link: string; appliedAtDate: string; approvedAtDate: boolean; currentStatus: string; currentReasons: string[]; restrictionsAtDate: Array<{ kind: string; reason: string }> }>;
    concessionsInForce: Array<{ id: string; number: string; characteristic: string; valid_until: string }>;
    changesInEffect: Array<{ id: string; number: string; title: string; effective_date: string }>;
  };
  inspections: Array<{ id: string; number: string; status: string; outcome: string | null; part_number: string; supplier: string | null; site: string | null; lot_number: string | null; po_number: string | null; date_received: string; completed_at: string | null; form_number: string; form_revision: string | null; baseline_label: string | null; source_state_at_start: string; units: string[]; photos: number; flagged_rows: number; link: string }>;
  fai: Array<{ number: string; sample_type: string; status: string; decision: string | null; defects: string | null; lot_number: string | null; received_date: string; nonconforming: string[]; link: string }>;
  ncrs: Array<{ id: string; number: string; title: string; status: string; severity: string; confirmed_at: string; scopes: Array<{ label: string; lot: string; quantity: number; state: string; serials: string[]; released: number; decisions: Array<{ outcome: string; quantity: number; void: boolean }> }>; link: string }>;
  events: Array<{ id: string; number: string; title: string; status: string; reported_at: string; link: string }>;
  concessions: Array<{ id: string; number: string; status: string; characteristic: string; lot_number: string; valid_from: string; valid_until: string; link: string }>;
  changes: Array<{ id: string; number: string; title: string; status: string; effective_date: string | null; link: string }>;
  injectors: Array<{ id: string; serial_number: string; part_number: string; tests: number; repairs: number; latest: { testedAt: string; machineVerdict: string; pdiEvaluation: string } | null; link: string }>;
}

export function Trace() {
  const [params, setParams] = useSearchParams();
  const [part, setPart] = useState<PartOption | null>(null);
  const [lot, setLot] = useState(params.get('lot') ?? '');
  const [serial, setSerial] = useState(params.get('serial') ?? '');
  const [date, setDate] = useState(params.get('date') ?? '');
  const ready = Boolean(params.get('serial') || (params.get('partId') && params.get('lot')));
  const qs = new URLSearchParams();
  for (const k of ['partId', 'lot', 'serial', 'date']) if (params.get(k)) qs.set(k, params.get(k)!);
  const { data, error, loading } = useLoad<TraceData>(ready ? `/api/trace?${qs.toString()}` : null);
  const empty = data && !data.inspections.length && !data.ncrs.length && !data.injectors.length && !data.events.length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Traceability</h1>
          <div className="muted small">Find everything recorded for a lot or serial, and what requirements and source approval applied on a given date.</div>
        </div>
      </div>
      <ReportTabs />
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          const next: Record<string, string> = {};
          if (serial.trim()) next.serial = serial.trim();
          if (part) next.partId = part.id;
          else if (params.get('partId')) next.partId = params.get('partId')!;
          if (lot.trim()) next.lot = lot.trim();
          if (date) next.date = date;
          setParams(next);
        }}
      >
        <div className="two-col">
          <div className="field">
            <label htmlFor="part-number">Part</label>
            <PartTypeahead value={part} onSelect={setPart} />
          </div>
          <div className="field">
            <label htmlFor="tr-lot">Lot</label>
            <input id="tr-lot" value={lot} onChange={(e) => setLot(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="tr-serial">or Serial</label>
            <input id="tr-serial" value={serial} onChange={(e) => setSerial(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="tr-date">Applied on date (default today)</label>
            <input id="tr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <button type="submit" className="btn btn-primary">
          Trace
        </button>
      </form>
      {!ready && <div className="empty card">Enter a serial, or a part and lot.</div>}
      <LoadState loading={loading && ready && !data} error={error} />
      {data && (
        <>
          <section className="card" aria-labelledby="applied-h">
            <h2 id="applied-h">
              What applied on {fmtDate(data.appliedOn.date)}
              {data.parts.length > 0 && ` — ${data.parts.map((p) => p.part_number).join(', ')}`}
            </h2>
            <h3 className="small">Requirements (released revisions)</h3>
            {data.appliedOn.baselines.length === 0 ? (
              <p className="muted small">No released requirement revision on or before this date.</p>
            ) : (
              <ul className="small">
                {data.appliedOn.baselines.map((b) => (
                  <li key={b.link}>
                    <Link to={b.link}>
                      {b.title} Rev {b.revision_label}
                    </Link>{' '}
                    released {fmtDate(b.released_at)} {b.status === 'SUPERSEDED' && <span className="muted">(since superseded)</span>}
                  </li>
                ))}
              </ul>
            )}
            <h3 className="small">Sources</h3>
            {data.appliedOn.sources.length === 0 ? (
              <p className="muted small">No source on record.</p>
            ) : (
              <ul className="small">
                {data.appliedOn.sources.map((s) => (
                  <li key={s.id}>
                    <Link to={s.link}>
                      {s.supplier} / {s.site}
                    </Link>{' '}
                    ({s.part_number}, {s.configuration.toLowerCase()}): <strong>{s.appliedAtDate}</strong>
                    <div className="muted">
                      Now: {words(s.currentStatus)}
                      {s.currentReasons.length ? ` — ${s.currentReasons.join('; ')}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.appliedOn.concessionsInForce.length > 0 && (
              <p className="small">
                Concessions in force:{' '}
                {data.appliedOn.concessionsInForce.map((c) => (
                  <Link key={c.id} to={`/quality/concessions/${c.id}`} style={{ marginRight: 8 }}>
                    {c.number} ({c.characteristic})
                  </Link>
                ))}
              </p>
            )}
            {data.appliedOn.changesInEffect.length > 0 && (
              <p className="small">
                Changes in effect:{' '}
                {data.appliedOn.changesInEffect.map((c) => (
                  <Link key={c.id} to={`/changes/${c.id}`} style={{ marginRight: 8 }}>
                    {c.number} {c.title} (from {fmtDate(c.effective_date)})
                  </Link>
                ))}
              </p>
            )}
          </section>
          {empty && <div className="empty card">No inspections, quality records or bench tests found for this lot or serial.</div>}
          {data.inspections.length > 0 && (
            <section className="card" aria-labelledby="ti-h">
              <h2 id="ti-h">Receiving inspections</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Inspection</th>
                      <th>Form / spec used</th>
                      <th>Supplier</th>
                      <th>Lot / serials</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.inspections.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <Link to={i.link}>{i.number}</Link>
                          <div className="small muted">received {fmtDate(i.date_received)}</div>
                        </td>
                        <td className="small">
                          {i.form_number} {i.form_revision ? `Rev ${i.form_revision}` : ''}
                          <div className="muted">{i.baseline_label ?? 'No released spec snapshot'}</div>
                        </td>
                        <td className="small">
                          {i.supplier ?? '—'} {i.site ? `/ ${i.site}` : ''}
                          <div className="muted">source at start: {words(i.source_state_at_start)}</div>
                        </td>
                        <td className="small">
                          {i.lot_number ?? '—'}
                          <div className="muted">{i.units.join(', ')}</div>
                        </td>
                        <td>
                          <StatusBadge status={i.status} /> <OutcomeBadge outcome={i.outcome} />
                          <div className="small muted">
                            {i.flagged_rows} flagged row(s), {i.photos} photo(s)
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {data.fai.length > 0 && (
            <section className="card" aria-labelledby="tf-h">
              <h2 id="tf-h">First article history</h2>
              <ul className="small">
                {data.fai.map((f) => (
                  <li key={f.number}>
                    <Link to={f.link}>{f.number}</Link> {words(f.sample_type)} received {fmtDate(f.received_date)} — {f.decision ? words(f.decision) : words(f.status)}
                    {f.defects ? `: ${f.defects}` : ''}
                    {f.nonconforming.length > 0 && <div className="field-error">Nonconforming: {f.nonconforming.join(', ')}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(data.ncrs.length > 0 || data.events.length > 0) && (
            <section className="card" aria-labelledby="tq-h">
              <h2 id="tq-h">Quality records</h2>
              <ul className="small">
                {data.events.map((e) => (
                  <li key={e.id}>
                    <Link to={e.link}>{e.number}</Link> {e.title} <StatusBadge status={e.status} />
                  </li>
                ))}
                {data.ncrs.map((n) => (
                  <li key={n.id}>
                    <Link to={n.link}>{n.number}</Link> {n.title} <StateBadge state={n.status} /> <span className="muted">{n.severity.toLowerCase()}</span>
                    {n.scopes.map((s, k) => (
                      <div key={k} className="muted">
                        {s.label}: lot {s.lot}, qty {s.quantity}, {words(s.state)}
                        {s.decisions.length > 0 && ` — ${s.decisions.map((d) => `${words(d.outcome)} ${d.quantity}${d.void ? ' (void)' : ''}`).join(', ')}`}
                        {s.released > 0 && `; ${s.released} released`}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(data.concessions.length > 0 || data.changes.length > 0) && (
            <section className="card" aria-labelledby="tc-h">
              <h2 id="tc-h">Concessions and changes</h2>
              <ul className="small">
                {data.concessions.map((c) => (
                  <li key={c.id}>
                    <Link to={c.link}>{c.number}</Link> {c.characteristic}, lot {c.lot_number}, {fmtDate(c.valid_from)}–{fmtDate(c.valid_until)} <StateBadge state={c.status} />
                  </li>
                ))}
                {data.changes.map((c) => (
                  <li key={c.id}>
                    <Link to={c.link}>{c.number}</Link> {c.title} <StateBadge state={c.status} /> {c.effective_date && <span className="muted">effective {fmtDate(c.effective_date)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.injectors.length > 0 && (
            <section className="card" aria-labelledby="tj-h">
              <h2 id="tj-h">Bench test and repair history</h2>
              <ul className="small">
                {data.injectors.map((j) => (
                  <li key={j.id}>
                    <Link to={j.link}>{j.serial_number}</Link> ({j.part_number}) — {j.tests} test(s), {j.repairs} repair case(s)
                    {j.latest && (
                      <span className="muted">
                        ; latest {fmtDateTime(j.latest.testedAt)}: machine {words(j.latest.machineVerdict)}, PDI {words(j.latest.pdiEvaluation)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
