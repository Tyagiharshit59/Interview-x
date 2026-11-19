import { Link } from 'react-router-dom';
import { get, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Card, ErrorBox, Loading, Meter, statusBadge, useLoad } from '../ui';

export function Dashboard() {
  const { me, can } = useAuth();
  const { data: jobs } = useLoad(() => get('/jobs'));
  const { data: cands } = useLoad(() => get('/candidates'));
  const { data: up, loading, error } = useLoad(() => get('/dashboard/upcoming'));
  const { data: usage } = useLoad(() => get('/usage'));
  const { data: ints } = useLoad(() => get('/interviews'));
  if (loading) return <Loading />;
  const steps = [
    { done: (jobs?.items.length || 0) > 0, label: 'Create your first job', to: '/jobs/new' },
    { done: (cands?.items.length || 0) > 0, label: 'Add a candidate (upload a CV)', to: '/candidates' },
    { done: (ints?.items.length || 0) > 0, label: 'Schedule your first interview', to: '/interviews/new' },
  ];
  const allDone = steps.every(s => s.done);
  return (
    <div className="stack">
      <h1>Welcome back, {me?.user.name.split(' ')[0]}</h1>
      <ErrorBox error={error} />
      {!allDone && (
        <Card title="Get started in three steps">
          <div className="stack gap-sm">{steps.map((s, i) => <div key={i} className="row"><span className={`badge ${s.done ? 'ok' : ''}`}>{s.done ? '✓' : i + 1}</span>{s.done ? <s className="muted">{s.label}</s> : <Link to={s.to}>{s.label}</Link>}</div>)}</div>
        </Card>
      )}
      <div className="grid g4">
        <Card className="stat"><div className="v">{jobs?.items.filter((j: any) => j.status === 'published').length ?? '–'}</div><div className="l">Active jobs</div></Card>
        <Card className="stat"><div className="v">{cands?.items.length ?? '–'}</div><div className="l">Candidates</div></Card>
        <Card className="stat"><div className="v">{ints?.items.filter((i: any) => i.status === 'scheduled').length ?? '–'}</div><div className="l">Upcoming interviews</div></Card>
        <Card className="stat"><div className="v">{ints?.items.filter((i: any) => i.status === 'completed' && i.feedback_count === 0).length ?? '–'}</div><div className="l">Awaiting feedback</div></Card>
      </div>
      <div className="grid g2">
        <Card title="Your upcoming interviews" actions={can('interviews.schedule') && <Link className="btn sm primary" to="/interviews/new">Schedule</Link>}>
          {up?.items.length ? <table><tbody>{up.items.map((i: any) => (
            <tr key={i.id}><td><Link to={`/interviews/${i.id}`}><b>{i.title}</b></Link><div className="small muted">{i.candidate_name}</div></td><td>{fmtDate(i.scheduled_at)}</td><td>{statusBadge(i.status)}</td><td><Link className="btn sm" to={`/interviews/${i.id}/room`}>Open room</Link></td></tr>
          ))}</tbody></table> : <div className="muted">Nothing scheduled for you.</div>}
        </Card>
        <Card title="Plan usage this period" actions={can('billing.manage') && <Link className="btn sm" to="/billing">Manage</Link>}>
          {usage && <div className="stack gap-sm">
            <div><div className="small">Team accounts</div><Meter used={usage.members.used} limit={usage.members.limit} /></div>
            <div><div className="small">Interviews</div><Meter used={usage.interviews.used} limit={usage.interviews.limit} /></div>
            <div><div className="small">Code runs</div><Meter used={usage.code_runs.used} limit={usage.code_runs.limit} /></div>
            <div><div className="small">AI requests</div><Meter used={usage.ai_calls.used} limit={usage.ai_calls.limit} /></div>
          </div>}
        </Card>
      </div>
    </div>
  );
}
