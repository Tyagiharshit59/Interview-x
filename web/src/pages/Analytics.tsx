import { useState } from 'react';
import { get } from '../api';
import { useAuth } from '../auth';
import { Card, ErrorBox, Loading, useLoad, PageHeader } from '../ui';

export function Analytics() {
  const { can } = useAuth();
  const [flt, setFlt] = useState({ from: '', to: '', jobId: '', department: '', recruiterId: '', interviewerId: '', status: '' });
  const qs = new URLSearchParams(Object.entries(flt).filter(([, v]) => v).map(([k, v]) => [k, k === 'to' ? v + 'T23:59:59Z' : v])).toString();
  const { data, error, loading } = useLoad(() => get(`/analytics?${qs}`), [qs]);
  const { data: jobs } = useLoad(() => get('/jobs'));
  const { data: team } = useLoad(() => get('/team'));
  const set = (k: string, v: string) => setFlt(p => ({ ...p, [k]: v }));
  const max = Math.max(1, ...(data?.funnel.map((f: any) => f.count) || [1]));
  return (
    <div className="stack">
      <PageHeader eyebrow="Insights" title="Analytics" description="Funnel, interviewer load and coding performance across your hiring." actions={can('reports.export') && <><a className="btn sm" href="/api/reports/export?type=candidates">Export candidates CSV</a><a className="btn sm" href="/api/reports/export?type=interviews">Export interviews CSV</a></>} />
      <Card>
        <div className="grid g4">
          <label className="field">From<input type="date" value={flt.from} onChange={e => set('from', e.target.value)} /></label>
          <label className="field">To<input type="date" value={flt.to} onChange={e => set('to', e.target.value)} /></label>
          <label className="field">Job<select value={flt.jobId} onChange={e => set('jobId', e.target.value)}><option value="">All</option>{jobs?.items.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></label>
          <label className="field">Department<select value={flt.department} onChange={e => set('department', e.target.value)}><option value="">All</option>{data?.departments.map((d: string) => <option key={d}>{d}</option>)}</select></label>
          <label className="field">Recruiter<select value={flt.recruiterId} onChange={e => set('recruiterId', e.target.value)}><option value="">All</option>{team?.members.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select></label>
          <label className="field">Interviewer<select value={flt.interviewerId} onChange={e => set('interviewerId', e.target.value)}><option value="">All</option>{team?.members.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select></label>
          <label className="field">Interview status<select value={flt.status} onChange={e => set('status', e.target.value)}><option value="">All</option><option>scheduled</option><option>in_progress</option><option>completed</option><option>cancelled</option></select></label>
        </div>
      </Card>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && <>
        <div className="grid g4">{Object.entries(data.metrics).map(([k, m]: any) => <Card key={k} className="stat"><div className="v">{m.value}{k === 'avgDurationMin' ? <small className="muted"> min</small> : ''}</div><div className="l">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c: string) => c.toUpperCase())}</div><div className="small muted" style={{ marginTop: 6 }}>{m.help}</div></Card>)}</div>
        <div className="grid g2">
          <Card title="Hiring funnel"><div className="stack gap-sm">{data.funnel.map((f: any) => <div key={f.stage}><div className="row between small"><span>{f.stage}</span><b>{f.count}</b></div><div className="meter"><i style={{ width: `${(f.count / max) * 100}%` }} /></div></div>)}</div><p className="small muted">Current number of applications in each stage (not cumulative conversion).</p></Card>
          <Card title="Coding assessments"><div className="row"><div className="stat"><div className="v">{data.coding.submissions}</div><div className="l">Submissions</div></div><div className="stat"><div className="v">{data.coding.avg_score ?? '–'}{data.coding.avg_score != null && '%'}</div><div className="l">Avg score</div></div><div className="stat"><div className="v">{data.coding.full_pass ?? 0}</div><div className="l">Full pass</div></div></div><p className="small muted">{data.coding.help}</p></Card>
        </div>
        <Card title="Interviewer activity">{data.byInterviewer.length ? <table><thead><tr><th>Interviewer</th><th>Assigned</th><th>Completed</th></tr></thead><tbody>{data.byInterviewer.map((r: any) => <tr key={r.name}><td>{r.name}</td><td>{r.interviews}</td><td>{r.completed}</td></tr>)}</tbody></table> : <div className="muted">No data for these filters.</div>}</Card>
      </>}
    </div>
  );
}
