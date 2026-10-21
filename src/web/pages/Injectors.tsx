import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BENCH_ADAPTER, BENCH_COLUMNS, REPAIR_ACTION_TEXT, REPAIR_ACTION_TYPES } from '../../shared/injectors';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { ColumnChart, PeriodFilter, VIZ, pctText } from '../components/charts';
import { HistoryCard, type HistoryRow, RecordPdfs, type Rendition, StateBadge } from '../components/quality';
import { useBusy } from '../components/sourcing';
import { Dialog, LoadState, OutcomeBadge, type PartOption, PartTypeahead, StatusBadge, useLoad } from '../components/ui';

const STAGE_TEXT: Record<string, string> = {
  FIRST_TEST: 'First test',
  RETEST_AFTER_REPAIR: 'Retest after repair',
  SHIPMENT_EVALUATION: 'Shipment evaluation',
  RETEST: 'Retest',
};
const EVAL_TEXT: Record<string, string> = {
  PASS: 'PDI pass',
  FAIL: 'PDI fail',
  NO_CRITERIA: 'No PDI criteria',
  PARTIAL_CRITERIA: 'Partial PDI criteria',
  NOT_TESTED: 'Not tested',
};

export function InjectorTabs() {
  const cls = ({ isActive }: { isActive: boolean }) => `btn btn-small${isActive ? ' btn-primary' : ''}`;
  return (
    <div className="row-actions" role="navigation" aria-label="Injector sections" style={{ marginBottom: 12 }}>
      <NavLink to="/injectors" end className={cls}>
        Injectors
      </NavLink>
      <NavLink to="/injectors/imports" className={cls}>
        Bench imports
      </NavLink>
      <NavLink to="/injectors/compare" className={cls}>
        Compare
      </NavLink>
      <NavLink to="/injectors/shipments" className={cls}>
        Shipment evaluations
      </NavLink>
      <NavLink to="/injectors/analytics" className={cls}>
        Analytics
      </NavLink>
    </div>
  );
}

/** Machine verdict and PDI evaluation are always shown side by side, never merged. */
function Verdicts({ machine, pdi }: { machine: string; pdi: string }) {
  return (
    <span className="row-actions" style={{ gap: 4 }}>
      <span className={`badge ${machine === 'PASS' ? 'badge-pass' : machine === 'FAIL' ? 'badge-fail' : ''}`} title="Verdict reported by the bench">
        Machine {machine === 'NOT_REPORTED' ? 'not reported' : machine.toLowerCase()}
      </span>
      <span className={`badge ${pdi === 'PASS' ? 'badge-pass' : pdi === 'FAIL' ? 'badge-fail' : 'badge-accepted'}`} title="Evaluation against released PDI criteria">
        {EVAL_TEXT[pdi] ?? pdi}
      </span>
    </span>
  );
}

interface ListRow {
  id: string;
  serialNumber: string;
  partNumber: string;
  description: string;
  oePartNumber: string | null;
  isSynthetic: boolean;
  tests: number;
  latest: { testedAt: string; machineVerdict: string; pdiEvaluation: string } | null;
  openRepairs: number;
}

function ImportButton() {
  const navigate = useNavigate();
  const { busy, run, banner } = useBusy();
  return (
    <span>
      <label className="btn btn-primary photo-btn" style={{ margin: 0 }}>
        {busy ? 'Importing…' : 'Import bench file'}
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Import bench file"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const form = new FormData();
            form.append('file', file, file.name);
            await run(async () => {
              const r = await api<{ importId: string }>('/api/injectors/imports', { form });
              navigate(`/injectors/imports/${r.importId}`);
            });
          }}
        />
      </label>
      {banner}
    </span>
  );
}

export function InjectorList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'register' | 'ship' | null>(null);
  const qs = new URLSearchParams();
  if (params.get('q')) qs.set('q', params.get('q')!);
  if (params.get('verdict')) qs.set('verdict', params.get('verdict')!);
  const { data, error, loading, reload } = useLoad<ListRow[]>(`/api/injectors?${qs.toString()}`);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Injectors</h1>
          <div className="muted small">Serialized injectors with bench tests, repairs and retests. Bench data arrives through the interim {BENCH_ADAPTER} file layout.</div>
        </div>
        <div className="row-actions">
          {can('injector.test') && (
            <>
              <button type="button" className="btn" onClick={() => setDialog('register')}>
                Register injector
              </button>
              <ImportButton />
            </>
          )}
        </div>
      </div>
      <InjectorTabs />
      <div className="card">
        <form
          className="row-actions"
          onSubmit={(e) => {
            e.preventDefault();
            const next = new URLSearchParams(params);
            if (q.trim()) next.set('q', q.trim());
            else next.delete('q');
            setParams(next);
          }}
        >
          <label htmlFor="inj-q" className="sr-only">
            Search injectors
          </label>
          <input id="inj-q" type="search" style={{ maxWidth: 320 }} placeholder="Serial, part or OE number" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn">
            Search
          </button>
          <label className="small" htmlFor="inj-verdict">
            Any test
          </label>
          <select
            id="inj-verdict"
            style={{ width: 'auto' }}
            value={params.get('verdict') ?? 'ANY'}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.value === 'ANY') next.delete('verdict');
              else next.set('verdict', e.target.value);
              setParams(next);
            }}
          >
            <option value="ANY">any result</option>
            <option value="FAIL">failed (machine or PDI)</option>
            <option value="PASS">passed (machine or PDI)</option>
          </select>
        </form>
      </div>
      {selected.length > 0 && (
        <div className="notice row-actions" role="region" aria-label="Selection">
          <span>{selected.length} selected</span>
          <button type="button" className="btn btn-small" disabled={selected.length > 12} onClick={() => navigate(`/injectors/compare?ids=${selected.join(',')}`)}>
            Compare{selected.length > 12 ? ' (max 12)' : ''}
          </button>
          {can('injector.evaluate') && (
            <button type="button" className="btn btn-small" onClick={() => setDialog('ship')}>
              Evaluate for shipment
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Select</span>
                </th>
                <th>Serial</th>
                <th>Part</th>
                <th>Tests</th>
                <th>Latest test</th>
                <th>Repairs</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">No injectors yet. Import a bench file or register a serial.</div>
                  </td>
                </tr>
              )}
              {data.map((i) => (
                <tr key={i.id}>
                  <td>
                    <input type="checkbox" aria-label={`Select ${i.serialNumber}`} checked={selected.includes(i.id)} onChange={() => toggle(i.id)} />
                  </td>
                  <td>
                    <Link to={`/injectors/${i.id}`}>{i.serialNumber}</Link> {i.isSynthetic && <span className="badge badge-synthetic">synthetic</span>}
                  </td>
                  <td className="small">
                    {i.partNumber}
                    <div className="muted">{i.description}</div>
                  </td>
                  <td>{i.tests}</td>
                  <td className="small">
                    {i.latest ? (
                      <>
                        {fmtDateTime(i.latest.testedAt)}
                        <div>
                          <Verdicts machine={i.latest.machineVerdict} pdi={i.latest.pdiEvaluation} />
                        </div>
                      </>
                    ) : (
                      <span className="muted">Not tested</span>
                    )}
                  </td>
                  <td>{i.openRepairs ? <span className="badge badge-review">{i.openRepairs} open</span> : <span className="muted small">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RegisterDialog
        open={dialog === 'register'}
        onClose={() => setDialog(null)}
        onDone={(id) => {
          setDialog(null);
          reload();
          navigate(`/injectors/${id}`);
        }}
      />
      <ShipmentDialog open={dialog === 'ship'} injectorIds={selected} onClose={() => setDialog(null)} />
    </>
  );
}

function RegisterDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [part, setPart] = useState<PartOption | null>(null);
  const [serial, setSerial] = useState('');
  const [oe, setOe] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open={open}
      title="Register injector"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !part || serial.trim().length < 2}
          onClick={() => run(async () => onDone((await api<{ id: string }>('/api/injectors', { body: { partId: part!.id, serialNumber: serial, oePartNumber: oe || null } })).id))}
        >
          Register
        </button>
      }
    >
      {banner}
      <div className="field">
        <label htmlFor="part-number">Company part</label>
        <PartTypeahead value={part} onSelect={setPart} />
      </div>
      <div className="field">
        <label htmlFor="reg-serial">Serial number</label>
        <input id="reg-serial" value={serial} onChange={(e) => setSerial(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="reg-oe">OE part number (optional)</label>
        <input id="reg-oe" value={oe} onChange={(e) => setOe(e.target.value)} />
      </div>
    </Dialog>
  );
}

function ShipmentDialog({ open, injectorIds, onClose }: { open: boolean; injectorIds: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open={open}
      title={`Shipment evaluation — ${injectorIds.length} injector(s)`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || reference.trim().length < 2}
          onClick={() =>
            run(async () => {
              const r = await api<{ id: string }>('/api/shipment-evaluations', { body: { reference, note: note || null, injectorIds } });
              navigate(`/injectors/shipments/${r.id}`);
            })
          }
        >
          Freeze evaluation
        </button>
      }
    >
      {banner}
      <p className="small muted">
        The latest recorded test of each injector is frozen with its PDI evaluation and machine verdict. Injectors without complete released PDI criteria are listed as exceptions. This record does not release material.
      </p>
      <div className="field">
        <label htmlFor="ship-ref">Shipment / order reference</label>
        <input id="ship-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ship-note">Note (optional)</label>
        <textarea id="ship-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}

interface TestRow {
  id: string;
  origin: string;
  import_id: string | null;
  import_number: string | null;
  machine_id: string;
  test_plan: string;
  tested_at: string;
  operator: string | null;
  machine_verdict: string;
  pdi_evaluation: string;
  criteria_label: string | null;
  repair_action_id: string | null;
  repair_case_number: string | null;
  note: string | null;
  stage: string;
  results: Array<{ condition: string; parameter: string; unit: string | null; value_text: string; machine_verdict: string | null; lower_limit: string | null; upper_limit: string | null; pdi_evaluation: string }>;
}

interface RepairCase {
  id: string;
  number: string;
  problem: string;
  status: string;
  openedAt: string;
  openedBy: string;
  closedAt: string | null;
  closureNote: string | null;
  version: number;
  actions: Array<{ id: string; actionType: keyof typeof REPAIR_ACTION_TEXT; description: string; componentReplaced: string | null; performedAt: string; technician: string; measurements: Array<{ name: string; value: string; unit: string | null }>; retests: string[] }>;
}

interface Detail {
  injector: { id: string; serialNumber: string; oePartNumber: string | null; notes: string | null; isSynthetic: boolean; partId: string; partNumber: string; description: string };
  tests: TestRow[];
  repairs: RepairCase[];
  shipments: Array<{ id: string; number: string; reference: string; evaluatedAt: string; result: string; basis: string }>;
  inspections: Array<{ id: string; number: string; status: string; outcome: string | null; dateReceived: string }>;
  quickMeasurements: string[];
  history: HistoryRow[];
  permissions: { test: boolean; evaluate: boolean; export: boolean };
}

const limitText = (r: TestRow['results'][number]) =>
  r.lower_limit !== null || r.upper_limit !== null ? `${r.lower_limit ?? '—'} to ${r.upper_limit ?? '—'}` : 'no PDI limit';

export function InjectorDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<Detail>(`/api/injectors/${id}`);
  const [dialog, setDialog] = useState<'test' | 'repair' | null>(null);
  const [actionFor, setActionFor] = useState<RepairCase | null>(null);
  const [closeFor, setCloseFor] = useState<RepairCase | null>(null);
  const [attribute, setAttribute] = useState<TestRow | null>(null);
  if (!data) return <LoadState loading={loading} error={error} />;
  const inj = data.injector;
  const openCase = data.repairs.find((r) => r.status === 'OPEN') ?? null;
  const actions = data.repairs.flatMap((r) => r.actions.map((a) => ({ ...a, caseNumber: r.number })));
  const done = () => {
    setDialog(null);
    setActionFor(null);
    setCloseFor(null);
    setAttribute(null);
    reload();
  };
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted">
            <Link to="/injectors">Injectors</Link> / {inj.partNumber}
          </div>
          <h1>
            {inj.serialNumber} {inj.isSynthetic && <span className="badge badge-synthetic">synthetic</span>}
          </h1>
          <div className="muted small">
            {inj.partNumber} — {inj.description}
            {inj.oePartNumber ? ` · OE ${inj.oePartNumber}` : ''}
          </div>
        </div>
        <div className="row-actions">
          <Link className="btn" to={`/trace?serial=${encodeURIComponent(inj.serialNumber)}`}>
            Trace serial
          </Link>
          {data.permissions.test && (
            <>
              <button type="button" className="btn" onClick={() => setDialog('test')}>
                Record bench test
              </button>
              {!openCase && (
                <button type="button" className="btn" onClick={() => setDialog('repair')}>
                  Open repair case
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <section className="card" aria-labelledby="chron-h">
        <h2 id="chron-h">Test chronology</h2>
        {data.tests.length === 0 ? (
          <p className="muted small">No bench tests recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="data stack">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Stage</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th>Values</th>
                </tr>
              </thead>
              <tbody>
                {data.tests.map((t) => (
                  <tr key={t.id}>
                    <td data-label="When" className="small">
                      {fmtDateTime(t.tested_at)}
                      <div className="muted">
                        {t.machine_id} · {t.test_plan}
                      </div>
                    </td>
                    <td data-label="Stage" className="small">
                      <span className="badge badge-done stage-badge">{STAGE_TEXT[t.stage] ?? t.stage}</span>
                      {t.repair_case_number && <div className="muted">after {t.repair_case_number}</div>}
                      {!t.repair_action_id && data.permissions.test && actions.some((a) => new Date(a.performedAt) <= new Date(t.tested_at)) && (
                        <div>
                          <button type="button" className="btn-link small" onClick={() => setAttribute(t)}>
                            Mark as retest of a repair
                          </button>
                        </div>
                      )}
                    </td>
                    <td data-label="Source" className="small">
                      {t.import_id ? <Link to={`/injectors/imports/${t.import_id}`}>{t.import_number}</Link> : 'Manual entry'}
                      {t.operator && <div className="muted">{t.operator}</div>}
                    </td>
                    <td data-label="Result" className="small">
                      <Verdicts machine={t.machine_verdict} pdi={t.pdi_evaluation} />
                      <div className="muted">{t.criteria_label ?? 'No released PDI criteria applied'}</div>
                    </td>
                    <td data-label="Values" className="small">
                      <details>
                        <summary>{t.results.length} values</summary>
                        <ul style={{ paddingLeft: 16, margin: '4px 0 0' }}>
                          {t.results.map((r) => (
                            <li key={`${r.condition}|${r.parameter}`}>
                              {r.condition} / {r.parameter}: <strong>{r.value_text}</strong> {r.unit ?? ''}{' '}
                              <span className={r.pdi_evaluation === 'OUTSIDE' ? 'field-error' : 'muted'}>
                                ({r.pdi_evaluation === 'OUTSIDE' ? 'outside ' : ''}
                                {limitText(r)}
                                {r.machine_verdict ? `; machine ${r.machine_verdict.toLowerCase()}` : ''})
                              </span>
                            </li>
                          ))}
                        </ul>
                        {t.note && <div className="muted">Note: {t.note}</div>}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="rep-h">
        <h2 id="rep-h">Repair cases</h2>
        {data.repairs.length === 0 && <p className="muted small">No repairs recorded.</p>}
        {data.repairs.map((c) => (
          <div key={c.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
            <div className="row-actions">
              <strong>{c.number}</strong> <StateBadge state={c.status === 'OPEN' ? 'OPEN' : 'CLOSED'} text={c.status.toLowerCase()} />
              <span className="small muted">
                opened {fmtDateTime(c.openedAt)} by {c.openedBy}
              </span>
              {c.status === 'OPEN' && data.permissions.test && (
                <>
                  <button type="button" className="btn btn-small" onClick={() => setActionFor(c)}>
                    Record repair action
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setCloseFor(c)}>
                    Close case
                  </button>
                </>
              )}
            </div>
            <div className="small">Problem: {c.problem}</div>
            {c.closureNote && <div className="small">Closed {fmtDateTime(c.closedAt)}: {c.closureNote}</div>}
            <ul className="small" style={{ paddingLeft: 18 }}>
              {c.actions.map((a) => (
                <li key={a.id}>
                  {fmtDateTime(a.performedAt)} — {REPAIR_ACTION_TEXT[a.actionType]}: {a.description}
                  {a.componentReplaced ? ` (replaced ${a.componentReplaced})` : ''} — {a.technician}
                  {a.measurements.length > 0 && <div className="muted">{a.measurements.map((m) => `${m.name} ${m.value}${m.unit ? ` ${m.unit}` : ''}`).join(' · ')}</div>}
                  <div className={a.retests.length ? 'muted' : 'field-error'}>{a.retests.length ? `${a.retests.length} retest(s) attributed` : 'No retest attributed yet'}</div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <div className="two-col">
        <section className="card" aria-labelledby="ship-h">
          <h2 id="ship-h">Shipment evaluations</h2>
          {data.shipments.length === 0 ? (
            <p className="muted small">Not part of any shipment evaluation.</p>
          ) : (
            <ul className="small">
              {data.shipments.map((s) => (
                <li key={s.id}>
                  <Link to={`/injectors/shipments/${s.id}`}>{s.number}</Link> {s.reference} — {EVAL_TEXT[s.result] ?? s.result} ({fmtDate(s.evaluatedAt)})
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="ins-h">
          <h2 id="ins-h">Receiving inspections of this serial</h2>
          {data.inspections.length === 0 ? (
            <p className="muted small">No inspection recorded this serial.</p>
          ) : (
            <ul className="small">
              {data.inspections.map((i) => (
                <li key={i.id}>
                  <Link to={`/inspections/${i.id}`}>{i.number}</Link> {fmtDate(i.dateReceived)} <StatusBadge status={i.status} /> <OutcomeBadge outcome={i.outcome} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <HistoryCard history={data.history} />

      <TestDialog open={dialog === 'test'} detail={data} onClose={() => setDialog(null)} onDone={done} />
      <OpenRepairDialog open={dialog === 'repair'} injectorId={inj.id} onClose={() => setDialog(null)} onDone={done} />
      {actionFor && <RepairActionDialog repair={actionFor} quick={data.quickMeasurements} onClose={() => setActionFor(null)} onDone={done} />}
      {closeFor && <CloseRepairDialog repair={closeFor} onClose={() => setCloseFor(null)} onDone={done} />}
      {attribute && (
        <AttributeDialog test={attribute} actions={actions.filter((a) => new Date(a.performedAt) <= new Date(attribute.tested_at))} onClose={() => setAttribute(null)} onDone={done} />
      )}
    </>
  );
}

const nowLocal = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function TestDialog({ open, detail, onClose, onDone }: { open: boolean; detail: Detail; onClose: () => void; onDone: () => void }) {
  const latest = detail.tests[detail.tests.length - 1];
  const template = latest?.results.map((r) => ({ condition: r.condition, parameter: r.parameter, unit: r.unit ?? '', value: '', result: '' })) ?? [{ condition: '', parameter: '', unit: '', value: '', result: '' }];
  const [rows, setRows] = useState(template);
  const [machineId, setMachineId] = useState(latest?.machine_id ?? '');
  const [testPlan, setTestPlan] = useState(latest?.test_plan ?? '');
  const [testedAt, setTestedAt] = useState(nowLocal());
  const [repairActionId, setRepairActionId] = useState('');
  const [note, setNote] = useState('');
  const { busy, run, banner } = useBusy();
  // Default to the time the dialog is opened, not when the page loaded (a repair may have been recorded since).
  useEffect(() => {
    if (open) setTestedAt(nowLocal());
  }, [open]);
  const actions = detail.repairs.flatMap((c) => c.actions.map((a) => ({ ...a, caseNumber: c.number })));
  const set = (i: number, k: keyof (typeof rows)[number], v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Dialog
      open={open}
      title="Record bench test"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !machineId || !testPlan || rows.some((r) => !r.condition || !r.parameter || !r.value)}
          onClick={() =>
            run(async () => {
              await api(`/api/injectors/${detail.injector.id}/tests`, {
                body: {
                  machineId,
                  testPlan,
                  testedAt: new Date(testedAt).toISOString(),
                  repairActionId: repairActionId || null,
                  note: note || null,
                  results: rows.map((r) => ({ condition: r.condition, parameter: r.parameter, unit: r.unit || null, value: r.value, result: r.result || null })),
                },
              });
              onDone();
            })
          }
        >
          Save test
        </button>
      }
    >
      {banner}
      <p className="small muted">Manual entry for a bench without a file export. Values are kept exactly as typed; the PDI evaluation uses released PDI criteria only.</p>
      <div className="two-col">
        <div className="field">
          <label htmlFor="t-machine">Machine</label>
          <input id="t-machine" value={machineId} onChange={(e) => setMachineId(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-plan">Test plan</label>
          <input id="t-plan" value={testPlan} onChange={(e) => setTestPlan(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-at">Tested at</label>
          <input id="t-at" type="datetime-local" value={testedAt} onChange={(e) => setTestedAt(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-repair">Retest after repair action</label>
          <select id="t-repair" value={repairActionId} onChange={(e) => setRepairActionId(e.target.value)}>
            <option value="">Not a retest after repair</option>
            {actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.caseNumber}: {REPAIR_ACTION_TEXT[a.actionType]} ({fmtDateTime(a.performedAt)})
              </option>
            ))}
          </select>
        </div>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Condition</th>
            <th>Parameter</th>
            <th>Unit</th>
            <th>Value</th>
            <th>Machine</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input aria-label={`Condition ${i + 1}`} value={r.condition} onChange={(e) => set(i, 'condition', e.target.value)} />
              </td>
              <td>
                <input aria-label={`Parameter ${i + 1}`} value={r.parameter} onChange={(e) => set(i, 'parameter', e.target.value)} />
              </td>
              <td>
                <input aria-label={`Unit ${i + 1}`} value={r.unit} onChange={(e) => set(i, 'unit', e.target.value)} />
              </td>
              <td>
                <input aria-label={`Value ${r.condition} ${r.parameter}`} inputMode="decimal" value={r.value} onChange={(e) => set(i, 'value', e.target.value)} />
              </td>
              <td>
                <select aria-label={`Machine result ${i + 1}`} value={r.result} onChange={(e) => set(i, 'result', e.target.value)}>
                  <option value="">—</option>
                  <option value="PASS">Pass</option>
                  <option value="FAIL">Fail</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn btn-small" style={{ marginTop: 8 }} onClick={() => setRows((rs) => [...rs, { condition: '', parameter: '', unit: '', value: '', result: '' }])}>
        + Add value
      </button>
      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor="t-note">Note (optional)</label>
        <input id="t-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}

function OpenRepairDialog({ open, injectorId, onClose, onDone }: { open: boolean; injectorId: string; onClose: () => void; onDone: () => void }) {
  const [problem, setProblem] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open={open}
      title="Open repair case"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || problem.trim().length < 5} onClick={() => run(async () => {
          await api(`/api/injectors/${injectorId}/repair-cases`, { body: { problem } });
          onDone();
        })}>
          Open case
        </button>
      }
    >
      {banner}
      <div className="field">
        <label htmlFor="rep-problem">Problem found</label>
        <textarea id="rep-problem" rows={3} value={problem} onChange={(e) => setProblem(e.target.value)} />
      </div>
    </Dialog>
  );
}

function RepairActionDialog({ repair, quick, onClose, onDone }: { repair: RepairCase; quick: string[]; onClose: () => void; onDone: () => void }) {
  const [actionType, setActionType] = useState<(typeof REPAIR_ACTION_TYPES)[number]>('ADJUSTMENT');
  const [description, setDescription] = useState('');
  const [component, setComponent] = useState('');
  const [performedAt, setPerformedAt] = useState(nowLocal());
  const [values, setValues] = useState<Record<string, { value: string; unit: string }>>({});
  const { busy, run, banner } = useBusy();
  const measurements = Object.entries(values)
    .filter(([, v]) => v.value.trim())
    .map(([name, v]) => ({ name, value: v.value.trim(), unit: v.unit.trim() || null }));
  return (
    <Dialog
      open
      title={`${repair.number}: record repair action`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || description.trim().length < 3 || (actionType === 'COMPONENT_REPLACEMENT' && !component.trim())}
          onClick={() =>
            run(async () => {
              await api(`/api/repair-cases/${repair.id}/actions`, {
                body: { actionType, description, componentReplaced: component || null, performedAt: new Date(performedAt).toISOString(), measurements },
              });
              onDone();
            })
          }
        >
          Save action
        </button>
      }
    >
      {banner}
      <div className="field">
        <label htmlFor="ra-type">Action</label>
        <select id="ra-type" value={actionType} onChange={(e) => setActionType(e.target.value as typeof actionType)}>
          {REPAIR_ACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {REPAIR_ACTION_TEXT[t]}
            </option>
          ))}
        </select>
      </div>
      {actionType === 'COMPONENT_REPLACEMENT' && (
        <div className="field">
          <label htmlFor="ra-comp">Component replaced</label>
          <input id="ra-comp" value={component} onChange={(e) => setComponent(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label htmlFor="ra-desc">What was done</label>
        <textarea id="ra-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ra-at">Performed at</label>
        <input id="ra-at" type="datetime-local" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} />
      </div>
      <fieldset>
        <legend className="small">Quick measurements (optional, recorded as entered; no limits applied)</legend>
        {quick.map((name) => (
          <div key={name} className="row-actions" style={{ marginBottom: 6 }}>
            <label htmlFor={`qm-${name.replace(/\W+/g, '-')}`} style={{ width: 140, margin: 0 }} className="small">
              {name}
            </label>
            <input
              id={`qm-${name.replace(/\W+/g, '-')}`}
              inputMode="decimal"
              style={{ width: 100 }}
              value={values[name]?.value ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: { value: e.target.value, unit: v[name]?.unit ?? '' } }))}
            />
            <input
              aria-label={`${name} unit`}
              placeholder="unit"
              style={{ width: 70 }}
              value={values[name]?.unit ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: { value: v[name]?.value ?? '', unit: e.target.value } }))}
            />
          </div>
        ))}
      </fieldset>
    </Dialog>
  );
}

function CloseRepairDialog({ repair, onClose, onDone }: { repair: RepairCase; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={`Close ${repair.number}`}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || note.trim().length < 5} onClick={() => run(async () => {
          await api(`/api/repair-cases/${repair.id}/close`, { body: { note, expectedVersion: repair.version } });
          onDone();
        })}>
          Close case
        </button>
      }
    >
      {banner}
      <p className="small muted">A repair case closes only after a retest has been attributed to one of its actions.</p>
      <div className="field">
        <label htmlFor="rc-note">Closure note</label>
        <textarea id="rc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}

function AttributeDialog({ test, actions, onClose, onDone }: { test: TestRow; actions: Array<RepairCase['actions'][number] & { caseNumber: string }>; onClose: () => void; onDone: () => void }) {
  const [actionId, setActionId] = useState(actions[actions.length - 1]?.id ?? '');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title="Mark test as retest after repair"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || !actionId} onClick={() => run(async () => {
          await api(`/api/injector-tests/${test.id}/retest-of`, { body: { repairActionId: actionId } });
          onDone();
        })}>
          Attribute retest
        </button>
      }
    >
      {banner}
      <p className="small muted">Test of {fmtDateTime(test.tested_at)}. The attribution is recorded once and cannot be changed.</p>
      <div className="field">
        <label htmlFor="attr-action">Repair action</label>
        <select id="attr-action" value={actionId} onChange={(e) => setActionId(e.target.value)}>
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.caseNumber}: {REPAIR_ACTION_TEXT[a.actionType]} — {a.description} ({fmtDateTime(a.performedAt)})
            </option>
          ))}
        </select>
      </div>
    </Dialog>
  );
}

interface ImportRow {
  id: string;
  number: string;
  status: string;
  adapter: string;
  testsTotal: number;
  testsAdded: number;
  testsDuplicate: number;
  testsConflict: number;
  testsExcluded: number;
  injectorsAdded: number;
  importedAt: string;
  importedBy: string;
  fileName: string;
}

export function ImportList() {
  const { can } = useAuth();
  const { data, error, loading } = useLoad<ImportRow[]>('/api/injectors/imports');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bench imports</h1>
          <div className="muted small">Every uploaded file is kept unchanged. Re-importing adds only tests not already recorded; conflicting values never overwrite.</div>
        </div>
        {can('injector.test') && <ImportButton />}
      </div>
      <InjectorTabs />
      <details className="card small">
        <summary>Interim file layout ({BENCH_ADAPTER})</summary>
        <p>
          One row per measured value, UTF-8 CSV with this header: <code>{BENCH_COLUMNS.join(',')}</code>. <code>tested_at</code> must include a time zone (for example 2026-10-01T08:15:00-05:00).
          A test is identified by machine, serial, time and sequence. This layout is synthetic and awaits real bench samples (POL-08); it is not a CarbonZapp format.
        </p>
      </details>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Import</th>
                <th>File</th>
                <th>Added</th>
                <th>Already present</th>
                <th>Conflicts</th>
                <th>Excluded</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">No bench files imported yet.</div>
                  </td>
                </tr>
              )}
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/injectors/imports/${r.id}`}>{r.number}</Link>
                    {r.status === 'DUPLICATE_FILE' && <div className="small muted">same file imported before</div>}
                  </td>
                  <td className="small">{r.fileName}</td>
                  <td>{r.testsAdded}</td>
                  <td>{r.testsDuplicate}</td>
                  <td>{r.testsConflict ? <span className="badge badge-fail">{r.testsConflict}</span> : 0}</td>
                  <td>{r.testsExcluded ? <span className="badge badge-accepted">{r.testsExcluded}</span> : 0}</td>
                  <td className="small">
                    {r.importedBy}
                    <div className="muted">{fmtDateTime(r.importedAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface ImportDetailData {
  import: {
    number: string;
    status: string;
    adapter: string;
    file_id: string;
    file_name: string;
    file_sha256: string;
    tests_total: number;
    tests_added: number;
    tests_duplicate: number;
    tests_conflict: number;
    tests_excluded: number;
    injectors_added: number;
    imported_at: string;
    imported_by_name: string;
    report: { priorImport: string | null; tests: Array<{ key: string; serial?: string; testedAt?: string; outcome: string; reason?: string; injectorId?: string }> };
  };
  adapterNote: string;
}

const OUTCOME_ORDER = ['CONFLICT', 'EXCLUDED', 'ADDED', 'DUPLICATE'];

export function ImportDetail() {
  const { id = '' } = useParams();
  const { data, error, loading } = useLoad<ImportDetailData>(`/api/injectors/imports/${id}`);
  if (!data) return <LoadState loading={loading} error={error} />;
  const b = data.import;
  const rows = [...b.report.tests].sort((x, y) => OUTCOME_ORDER.indexOf(x.outcome) - OUTCOME_ORDER.indexOf(y.outcome));
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted">
            <Link to="/injectors/imports">Bench imports</Link>
          </div>
          <h1>{b.number}</h1>
          <div className="muted small">
            {b.file_name} · imported {fmtDateTime(b.imported_at)} by {b.imported_by_name} · {data.adapterNote}
          </div>
        </div>
        <a className="btn" href={`/api/files/${b.file_id}?download=1`}>
          Download original file
        </a>
      </div>
      {b.report.priorImport && <div className="notice notice-warn">This exact file was already imported as {b.report.priorImport}. Nothing was overwritten.</div>}
      <div className="metric-grid" role="list">
        {[
          ['Tests in file', b.tests_total],
          ['Added', b.tests_added],
          ['Already present', b.tests_duplicate],
          ['Conflicts (kept original)', b.tests_conflict],
          ['Excluded', b.tests_excluded],
          ['New injectors', b.injectors_added],
        ].map(([label, n]) => (
          <div className="metric" role="listitem" key={String(label)}>
            <strong>{n}</strong>
            <span className="small">{label}</span>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data stack">
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Serial</th>
              <th>Tested at</th>
              <th>Explanation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td data-label="Outcome">
                  <span className={`badge ${r.outcome === 'ADDED' ? 'badge-pass' : r.outcome === 'CONFLICT' ? 'badge-fail' : r.outcome === 'EXCLUDED' ? 'badge-accepted' : ''}`}>{r.outcome.toLowerCase()}</span>
                </td>
                <td data-label="Serial">{r.injectorId ? <Link to={`/injectors/${r.injectorId}`}>{r.serial}</Link> : (r.serial ?? r.key.split('|')[1] ?? '—')}</td>
                <td data-label="Tested at" className="small">{r.testedAt ? fmtDateTime(r.testedAt) : '—'}</td>
                <td data-label="Explanation" className="small">{r.reason ?? (r.outcome === 'ADDED' ? 'Recorded' : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface Comparison {
  injectors: Array<{ id: string; serialNumber: string; partNumber: string; tests: number; first: { testedAt: string; machineVerdict: string; pdiEvaluation: string } | null; latest: { testedAt: string; machineVerdict: string; pdiEvaluation: string; afterRepair: boolean } | null }>;
  rows: Array<{ condition: string; parameter: string; unit: string | null; values: Array<{ first: { value: string; evaluation: string } | null; latest: { value: string; evaluation: string } | null }> }>;
}

const flag = (v: { value: string; evaluation: string } | null) =>
  v ? <span className={v.evaluation === 'OUTSIDE' || v.evaluation === 'FAIL' ? 'field-error' : undefined}>{v.value}{v.evaluation === 'OUTSIDE' || v.evaluation === 'FAIL' ? ' (!)' : ''}</span> : <span className="muted">—</span>;

/** Waits for an issued snapshot's PDF rendition (rendered by the job worker). */
function useSnapshotPdf(snapshotId: string | null) {
  const [fileId, setFileId] = useState<string | null>(null);
  useEffect(() => {
    if (!snapshotId) return;
    setFileId(null);
    let stop = false;
    let tries = 0;
    const poll = async () => {
      try {
        const s = await api<{ fileId: string | null }>(`/api/report-snapshots/${snapshotId}`);
        if (s.fileId) return setFileId(s.fileId);
      } catch {
        /* retried below */
      }
      tries += 1;
      if (!stop && tries < 30) setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [snapshotId]);
  return fileId;
}

export function Compare() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const ids = params.get('ids') ?? '';
  const { data, error, loading } = useLoad<Comparison>(ids ? `/api/injectors/compare?ids=${encodeURIComponent(ids)}` : null);
  const { busy, run, banner } = useBusy();
  const [snapshot, setSnapshot] = useState<{ id: string; number: string } | null>(null);
  const fileId = useSnapshotPdf(snapshot?.id ?? null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compare injectors</h1>
          <div className="muted small">First and latest test values in the order selected. Values recorded in different units stay on separate rows.</div>
        </div>
        {data && can('reports.export') && (
          <div className="row-actions">
            <a className="btn" href={`/api/exports/injector-compare.csv?ids=${encodeURIComponent(ids)}`}>
              Export CSV
            </a>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(async () => setSnapshot(await api<{ snapshotId: string; number: string }>('/api/injectors/compare/report', { body: { ids: ids.split(',') } }).then((r) => ({ id: r.snapshotId, number: r.number }))))}
            >
              Issue comparison PDF
            </button>
          </div>
        )}
      </div>
      <InjectorTabs />
      {banner}
      {snapshot && (
        <div className="notice notice-ok" role="status">
          {snapshot.number} issued.{' '}
          {fileId ? (
            <a href={`/api/files/${fileId}`} target="_blank" rel="noopener noreferrer">
              Open PDF
            </a>
          ) : (
            'Rendering PDF…'
          )}
        </div>
      )}
      {!ids && <div className="empty card">Select injectors on the Injectors list, then choose Compare.</div>}
      <LoadState loading={loading && Boolean(ids) && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Condition / parameter</th>
                <th>Unit</th>
                {data.injectors.map((i) => (
                  <th key={i.id}>
                    <Link to={`/injectors/${i.id}`}>{i.serialNumber}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="small muted">Tests (first → latest)</td>
                <td />
                {data.injectors.map((i) => (
                  <td key={i.id} className="small">
                    {i.tests} test(s)
                    {i.first && (
                      <div>
                        <Verdicts machine={i.first.machineVerdict} pdi={i.first.pdiEvaluation} />
                      </div>
                    )}
                    {i.latest && (
                      <div>
                        → <Verdicts machine={i.latest.machineVerdict} pdi={i.latest.pdiEvaluation} />
                        {i.latest.afterRepair && <span className="muted"> after repair</span>}
                      </div>
                    )}
                  </td>
                ))}
              </tr>
              {data.rows.map((r) => (
                <tr key={`${r.condition}|${r.parameter}|${r.unit}`}>
                  <td>
                    {r.condition} / {r.parameter}
                  </td>
                  <td className="small">{r.unit ?? '—'}</td>
                  {r.values.map((v, k) => (
                    <td key={k}>
                      {flag(v.first)}
                      {v.latest && <> → {flag(v.latest)}</>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ padding: '0 10px' }}>
            (!) outside released PDI criteria, or a machine fail where no PDI criteria are released.
          </p>
        </div>
      )}
    </>
  );
}

export function ShipmentList() {
  const { data, error, loading } = useLoad<Array<{ id: string; number: string; reference: string; conclusion: string; evaluatedAt: string; evaluatedBy: string; items: number }>>('/api/shipment-evaluations');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Shipment evaluations</h1>
          <div className="muted small">Frozen evaluations of injectors before shipment. Select injectors on the list to start one.</div>
        </div>
      </div>
      <InjectorTabs />
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Evaluation</th>
                <th>Reference</th>
                <th>Injectors</th>
                <th>Conclusion</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No shipment evaluations yet.</div>
                  </td>
                </tr>
              )}
              {data.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/injectors/shipments/${e.id}`}>{e.number}</Link>
                  </td>
                  <td>{e.reference}</td>
                  <td>{e.items}</td>
                  <td>
                    <span className={`badge ${e.conclusion === 'ALL_PASS' ? 'badge-pass' : 'badge-accepted'}`}>{e.conclusion === 'ALL_PASS' ? 'all pass' : 'exceptions'}</span>
                  </td>
                  <td className="small">
                    {e.evaluatedBy}
                    <div className="muted">{fmtDateTime(e.evaluatedAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function ShipmentDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<{
    evaluation: { number: string; reference: string; note: string | null; conclusion: string; evaluated_at: string; evaluated_by_name: string };
    items: Array<{ position: number; result: string; basis: string; injectorId: string; serialNumber: string; partNumber: string; testedAt: string | null; machineVerdict: string | null; pdiEvaluation: string | null }>;
    renditions: Rendition[];
  }>(`/api/shipment-evaluations/${id}`);
  useEffect(() => {
    if (data && data.renditions.some((r) => !r.fileId)) {
      const t = setTimeout(reload, 1500);
      return () => clearTimeout(t);
    }
  }, [data, reload]);
  if (!data) return <LoadState loading={loading} error={error} />;
  const e = data.evaluation;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted">
            <Link to="/injectors/shipments">Shipment evaluations</Link>
          </div>
          <h1>
            {e.number} <span className={`badge ${e.conclusion === 'ALL_PASS' ? 'badge-pass' : 'badge-accepted'}`}>{e.conclusion === 'ALL_PASS' ? 'all pass' : 'exceptions'}</span>
          </h1>
          <div className="muted small">
            {e.reference} · {e.evaluated_by_name}, {fmtDateTime(e.evaluated_at)} · this evaluation does not release material
          </div>
        </div>
      </div>
      <RecordPdfs renditions={data.renditions} issueUrl="" docCode="VAL-03" canIssue={false} onIssued={reload} />
      {e.note && <div className="notice">{e.note}</div>}
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Serial</th>
              <th>Latest test</th>
              <th>Result</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.position}>
                <td>{i.position}</td>
                <td>
                  <Link to={`/injectors/${i.injectorId}`}>{i.serialNumber}</Link>
                  <div className="small muted">{i.partNumber}</div>
                </td>
                <td className="small">{i.testedAt ? fmtDateTime(i.testedAt) : '—'}</td>
                <td>
                  <span className={`badge ${i.result === 'PASS' ? 'badge-pass' : i.result === 'FAIL' ? 'badge-fail' : 'badge-accepted'}`}>{EVAL_TEXT[i.result] ?? i.result}</span>
                </td>
                <td className="small">{i.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface Ratio {
  pass: number;
  of: number;
  percent: number | null;
}
interface Analytics {
  period: { from: string; to: string; timeZone: string };
  definitionsVersion: string;
  tests: number;
  injectors: number;
  retests: number;
  firstPassYield: { machine: Ratio; pdi: Ratio; firstTests: number };
  postRepairYield: { tests: number; machine: Ratio; pdi: Ratio };
  failureModes: Array<{ condition: string; parameter: string; failures: number; outside_pdi: number; machine_fail: number }>;
  adjustments: Array<{ actionType: keyof typeof REPAIR_ACTION_TEXT; actions: number; measurements: Array<{ name: string; count: number }> }>;
  weekly: Array<{ week: string; tests: number }>;
  definitions: string[];
}

export function InjectorAnalytics() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const qs = new URLSearchParams();
  if (params.get('from')) qs.set('from', params.get('from')!);
  if (params.get('to')) qs.set('to', params.get('to')!);
  const { data, error, loading } = useLoad<Analytics>(`/api/injectors/analytics?${qs.toString()}`);
  const ratio = (label: string, r: Ratio) => (
    <div className="metric" role="listitem">
      <strong>{pctText(r)}</strong>
      <span className="small">
        {label}: {r.pass} of {r.of}
      </span>
    </div>
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Injector analytics</h1>
          <div className="muted small">Machine verdicts and PDI evaluations are reported separately, each over the tests it could judge.</div>
        </div>
        {data && can('reports.export') && (
          <a className="btn" href={`/api/exports/injector-tests.csv?from=${data.period.from}&to=${data.period.to}`}>
            Export tests CSV
          </a>
        )}
      </div>
      <InjectorTabs />
      <div className="card">
        <PeriodFilter from={data?.period.from ?? params.get('from') ?? ''} to={data?.period.to ?? params.get('to') ?? ''} onChange={(from, to) => setParams({ from, to })} />
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <>
          <div className="metric-grid" role="list">
            <div className="metric" role="listitem">
              <strong>{data.tests}</strong>
              <span className="small">
                tests on {data.injectors} injector(s); {data.retests} retest(s)
              </span>
            </div>
            {ratio('First-pass yield, machine', data.firstPassYield.machine)}
            {ratio('First-pass yield, PDI criteria', data.firstPassYield.pdi)}
            {ratio('Post-repair yield, machine', data.postRepairYield.machine)}
            {ratio('Post-repair yield, PDI criteria', data.postRepairYield.pdi)}
          </div>
          <div className="two-col">
            <section className="card">
              <ColumnChart
                title="Bench tests per week"
                categories={data.weekly.map((w) => w.week)}
                series={[{ key: 'tests', label: 'Tests', color: VIZ.series1, values: data.weekly.map((w) => w.tests) }]}
                formatCategory={(w) => fmtDate(w).slice(0, 5)}
              />
            </section>
            <section className="card">
              <h2>Failure modes</h2>
              {data.failureModes.length === 0 ? (
                <p className="muted small">No failures in the period.</p>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Condition / parameter</th>
                      <th>Failures</th>
                      <th>Outside PDI</th>
                      <th>Machine fail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.failureModes.map((f) => (
                      <tr key={`${f.condition}|${f.parameter}`}>
                        <td>
                          {f.condition} / {f.parameter}
                        </td>
                        <td>{f.failures}</td>
                        <td>{f.outside_pdi}</td>
                        <td>{f.machine_fail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
          <section className="card">
            <h2>Repair actions</h2>
            {data.adjustments.length === 0 ? (
              <p className="muted small">No repair actions in the period.</p>
            ) : (
              <ul className="small">
                {data.adjustments.map((a) => (
                  <li key={a.actionType}>
                    {REPAIR_ACTION_TEXT[a.actionType]}: {a.actions}
                    {a.measurements.length > 0 && <span className="muted"> — measured {a.measurements.map((m) => `${m.name} (${m.count})`).join(', ')}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <details className="card small">
            <summary>Calculation definitions ({data.definitionsVersion})</summary>
            <ul>
              {data.definitions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </>
  );
}
