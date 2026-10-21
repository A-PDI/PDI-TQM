import { Link, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { LoadState, StatusBadge, useLoad } from '../components/ui';

interface HomeData {
  work: Array<{ id: string; kind: string; title: string; subjectType: string; subjectId: string; createdAt: string; assignee: string | null }>;
  drafts: Array<{ id: string; number: string; partNumber: string; partDescription: string; status: string; updatedAt: string; unitCount: number }>;
  counts: { awaiting_review: number; open_concerns: number; open_inspections: number };
  recent: Array<{ entityType: string; entityId: string; summary: string; occurredAt: string }>;
  teamView: boolean;
}

const KIND_LABEL: Record<string, string> = {
  INSPECTION_ASSIGNED: 'Inspection',
  INSPECTION_REVIEW: 'Review',
  CONCERN_TRIAGE: 'Triage',
  CONCERN_FOLLOW_UP: 'Follow-up',
};

const subjectLink = (type: string, id: string) => (type === 'INSPECTION' || type === 'inspection' ? `/inspections/${id}` : `/quality/${id}`);

export function Home() {
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const team = params.get('scope') === 'team';
  const { data, error, loading } = useLoad<HomeData>(`/api/home${team ? '?scope=team' : ''}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Work</h1>
          <div className="muted small">Good to see you, {me?.user.displayName.split(' ')[0]}.</div>
        </div>
        <div className="row-actions">
          {can('work.view_team') && (
            <button type="button" className="btn btn-small" onClick={() => setParams(team ? {} : { scope: 'team' })}>
              {team ? 'Show my work' : 'Show team work'}
            </button>
          )}
          {can('inspection.perform') && (
            <Link className="btn btn-primary" to="/inspections?new=1">
              New Inspection
            </Link>
          )}
        </div>
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <>
          <div className="card-grid">
            <Link className="stat" to="/inspections?mine=1&status=OPEN">
              <strong>{data.drafts.length}</strong> My open inspections
            </Link>
            <Link className="stat" to="/inspections?status=READY_FOR_REVIEW">
              <strong>{data.counts.awaiting_review}</strong> Inspections pending review
            </Link>
            <Link className="stat" to="/quality?status=OPEN">
              <strong>{data.counts.open_concerns}</strong> Open quality concerns
            </Link>
            <Link className="stat" to="/inspections?status=OPEN">
              <strong>{data.counts.open_inspections}</strong> Open inspections (all)
            </Link>
          </div>

          <section className="card" aria-labelledby="work-h">
            <h2 id="work-h">{data.teamView ? 'Team work queue' : 'Assigned to me or my role'}</h2>
            {data.work.length === 0 ? (
              <div className="empty">Nothing waiting on you. Start a new inspection or record a concern when needed.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Work</th>
                      <th>Assignee</th>
                      <th>Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.work.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <span className="badge">{KIND_LABEL[w.kind] ?? w.kind}</span>
                        </td>
                        <td>
                          <Link to={subjectLink(w.subjectType, w.subjectId)}>{w.title}</Link>
                        </td>
                        <td>{w.assignee ?? <span className="muted">Role queue</span>}</td>
                        <td className="small">{fmtDateTime(w.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="drafts-h">
            <h2 id="drafts-h">My open inspections</h2>
            {data.drafts.length === 0 ? (
              <div className="empty">No inspections in progress.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.drafts.map((d) => (
                  <li key={d.id} style={{ marginBottom: 4 }}>
                    <Link to={`/inspections/${d.id}`}>
                      {d.partNumber} — {d.partDescription}
                    </Link>{' '}
                    <span className="small muted">
                      {d.number} · {d.unitCount} item(s) · updated {fmtDateTime(d.updatedAt)}
                    </span>{' '}
                    <StatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.recent.length > 0 && (
            <section className="card" aria-labelledby="recent-h">
              <h2 id="recent-h">Recently worked on</h2>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.recent.map((r) => (
                  <li key={`${r.entityType}-${r.entityId}`}>
                    <Link to={subjectLink(r.entityType, r.entityId)}>{r.summary}</Link> <span className="small muted">{fmtDateTime(r.occurredAt)}</span>
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
