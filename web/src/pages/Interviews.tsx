import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fmtDate, get, patch, post, del } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, statusBadge, useConfirm, useLoad, useToast } from '../ui';

/** Convert a wall-clock time in a given IANA zone to a UTC ISO string. */
export function zonedToIso(local: string, tz: string) {
  const [d, t] = local.split('T'); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
  const target = Date.UTC(y, mo - 1, da, h, mi);
  const off = (ts: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts;
  };
  let utc = target; for (let i = 0; i < 3; i++) utc = target - off(utc);
  return new Date(utc).toISOString();
}
const zones = (() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'Asia/Kolkata']; } })();

export function InterviewsList() {
  const { can } = useAuth(); const [status, setStatus] = useState(''); const [mine, setMine] = useState(false);
  const { data, loading, error } = useLoad(() => get(`/interviews?${new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}) })}`), [status, mine]);
  return (
    <div className="stack">
      <div className="row between"><h1>Interviews</h1>{can('interviews.schedule') && <Link className="btn primary" to="/interviews/new">Schedule interview</Link>}</div>
      <div className="row"><select style={{ maxWidth: 190 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option><option>scheduled</option><option>in_progress</option><option>completed</option><option>cancelled</option></select>
        <label className="check"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />Only mine</label></div>
      <ErrorBox error={error} />
      <Card>{loading ? <Loading /> : !data?.items.length ? <Empty title="No interviews">Schedule one from a candidate profile or with the button above.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Interview</th><th>Candidate</th><th>When</th><th>Interviewers</th><th>Status</th><th>Feedback</th></tr></thead><tbody>
          {data.items.map((i: any) => <tr key={i.id}><td><Link to={`/interviews/${i.id}`}><b>{i.title}</b></Link><div className="small muted">{i.job_title} · round {i.round_no}</div></td><td><Link to={`/candidates/${i.candidate_id}`}>{i.candidate_name}</Link></td><td>{fmtDate(i.scheduled_at)}</td><td className="small">{i.interviewers}</td><td>{statusBadge(i.status)}</td><td>{i.feedback_count}</td></tr>)}
        </tbody></table></div>)}</Card>
    </div>
  );
}

export function ScheduleWizard() {
  const [sp] = useSearchParams(); const nav = useNavigate(); const toast = useToast();
  const [step, setStep] = useState(1); const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(''); const [app, setApp] = useState<any>(null);
  const tz0 = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const tomorrow = new Date(Date.now() + 864e5); tomorrow.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [f, setF] = useState<any>({ title: '', type: 'technical', local: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:00`, tz: tz0, durationMin: 60, instructions: '', interviewerIds: [] as string[], coding: true, whiteboard: true, recording: false, secondaryCamera: false, codingQuestionId: '', language: 'javascript', allowCandidateScreenShare: false });
  const { data: jobs } = useLoad(() => get('/jobs?status=published'));
  const { data: pipe } = useLoad(() => (jobId ? get(`/jobs/${jobId}/pipeline`) : Promise.resolve(null)), [jobId]);
  const { data: team } = useLoad(() => get('/team'));
  const { data: qs } = useLoad(() => get('/questions'));
  const { data: ent } = useLoad(() => get('/entitlements'));
  const { data: langs } = useLoad(() => get('/coding/languages'));
  useEffect(() => { const a = sp.get('applicationId'); if (a) get(`/applications/${a}`).then(r => { setApp(r); setF((p: any) => ({ ...p, title: `Technical interview: ${r.job_title}`, interviewerIds: r.interviewer_ids })); setStep(2); }).catch(setErr); }, [sp]);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const choose = (a: any) => { setApp({ id: a.id, candidate_name: a.name, job_title: jobs?.items.find((j: any) => j.id === jobId)?.title }); set('title', `Technical interview: ${a.name}`); };
  const interviewers = team?.members.filter((m: any) => m.status === 'active' && ['owner', 'admin', 'interviewer', 'hiring_manager'].includes(m.role)) || [];
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post('/interviews', { applicationId: app.id, title: f.title, type: f.type, scheduledAt: zonedToIso(f.local, f.tz), durationMin: Number(f.durationMin), timezone: f.tz, instructions: f.instructions || null, interviewerIds: f.interviewerIds,
        config: { coding: f.coding, whiteboard: f.whiteboard, recording: f.recording, secondaryCamera: f.secondaryCamera, codingQuestionId: f.codingQuestionId || null, language: f.language, allowCandidateScreenShare: f.allowCandidateScreenShare } });
      toast('Interview scheduled and invitation sent'); nav(`/interviews/${r.id}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Schedule interview</h1>
      <div className="row">{['Candidate', 'Details', 'Interviewers & tools', 'Review'].map((s, i) => <Badge key={s} kind={step === i + 1 ? 'primary' : step > i + 1 ? 'ok' : undefined}>{i + 1}. {s}</Badge>)}</div>
      <ErrorBox error={err} />
      {step === 1 && <Card title="Choose candidate">
        <div className="stack"><Field label="Job"><select value={jobId} onChange={e => { setJobId(e.target.value); setApp(null); }}><option value="">Select a published job…</option>{jobs?.items.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></Field>
          {pipe && <Field label="Candidate"><select value={app?.id || ''} onChange={e => { const a = pipe.items.find((x: any) => x.id === e.target.value); if (a) choose(a); }}><option value="">Select…</option>{pipe.items.map((a: any) => <option key={a.id} value={a.id}>{a.name} — {a.stage}</option>)}</select></Field>}
          {jobs && !jobs.items.length && <div className="alert warn">Publish a job and add a candidate first.</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" disabled={!app} onClick={() => setStep(2)}>Next</Button></div></div></Card>}
      {step === 2 && <Card title={`Details — ${app?.candidate_name}`}>
        <div className="grid g2">
          <Field label="Title"><input value={f.title} onChange={e => set('title', e.target.value)} required /></Field>
          <Field label="Type"><select value={f.type} onChange={e => set('type', e.target.value)}><option value="technical">Technical</option><option value="hr">HR</option><option value="system_design">System design</option><option value="managerial">Managerial</option><option value="coding_assessment">Coding assessment</option></select></Field>
          <Field label="Date & time"><input type="datetime-local" value={f.local} onChange={e => set('local', e.target.value)} /></Field>
          <Field label="Time zone"><select value={f.tz} onChange={e => set('tz', e.target.value)}>{zones.map(z => <option key={z}>{z}</option>)}</select></Field>
          <Field label="Duration (minutes)"><input type="number" min={15} max={480} step={5} value={f.durationMin} onChange={e => set('durationMin', e.target.value)} /></Field>
        </div>
        <Field label="Instructions for the candidate"><textarea value={f.instructions} onChange={e => set('instructions', e.target.value)} placeholder="What to prepare, what to expect…" /></Field>
        <p className="small muted">Shown to the candidate as {new Date(zonedToIso(f.local, f.tz)).toLocaleString()} in your browser's time zone.</p>
        <div className="row between"><Button onClick={() => setStep(1)}>Back</Button><Button variant="primary" onClick={() => setStep(3)} disabled={!f.title}>Next</Button></div></Card>}
      {step === 3 && <Card title="Interviewers & tools">
        <Field label="Interviewers" hint="The first selected person leads. Hold Ctrl/Cmd to pick several."><select multiple style={{ minHeight: 120 }} value={f.interviewerIds} onChange={e => set('interviewerIds', [...e.target.selectedOptions].map(o => o.value))}>{interviewers.map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name} ({m.role.replace('_', ' ')})</option>)}</select></Field>
        <div className="stack gap-sm" style={{ marginTop: 12 }}>
          <label className="check"><input type="checkbox" checked={f.coding} onChange={e => set('coding', e.target.checked)} />Collaborative coding workspace</label>
          {f.coding && <div className="grid g2"><Field label="Question"><select value={f.codingQuestionId} onChange={e => set('codingQuestionId', e.target.value)}><option value="">None (free-form)</option>{qs?.items.map((q: any) => <option key={q.id} value={q.id}>{q.title} ({q.difficulty})</option>)}</select></Field>
            <Field label="Default language"><select value={f.language} onChange={e => set('language', e.target.value)}>{langs?.languages.map((l: any) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></Field></div>}
          <label className="check"><input type="checkbox" checked={f.whiteboard} onChange={e => set('whiteboard', e.target.checked)} />Whiteboard</label>
          <label className="check"><input type="checkbox" checked={f.recording} disabled={ent && !ent.recording} onChange={e => set('recording', e.target.checked)} /><span>Allow recording (candidate must consent in the room){ent && !ent.recording && <Badge kind="warn">Not in your plan</Badge>}</span></label>
          <label className="check"><input type="checkbox" checked={f.secondaryCamera} disabled={ent && !ent.secondary_camera} onChange={e => set('secondaryCamera', e.target.checked)} /><span>Offer optional secondary phone camera (candidate scans a QR code and consents){ent && !ent.secondary_camera && <Badge kind="warn">Not in your plan</Badge>}</span></label>
          <label className="check"><input type="checkbox" checked={f.allowCandidateScreenShare} onChange={e => set('allowCandidateScreenShare', e.target.checked)} />Candidate may share their screen without asking</label>
        </div>
        <div className="row between" style={{ marginTop: 14 }}><Button onClick={() => setStep(2)}>Back</Button><Button variant="primary" disabled={!f.interviewerIds.length} onClick={() => setStep(4)}>Review</Button></div></Card>}
      {step === 4 && <Card title="Review">
        <table><tbody><tr><th>Candidate</th><td>{app?.candidate_name} ({app?.job_title})</td></tr><tr><th>Title</th><td>{f.title}</td></tr><tr><th>When</th><td>{new Date(zonedToIso(f.local, f.tz)).toLocaleString()} · {f.durationMin} min · {f.tz}</td></tr>
          <tr><th>Interviewers</th><td>{f.interviewerIds.map((i: string) => interviewers.find((m: any) => m.user_id === i)?.name).join(', ')}</td></tr>
          <tr><th>Tools</th><td>{[f.coding && 'coding', f.whiteboard && 'whiteboard', f.recording && 'recording', f.secondaryCamera && 'secondary camera'].filter(Boolean).join(', ') || 'video only'}</td></tr></tbody></table>
        <p className="small muted">The candidate receives a personal, expiring invitation link by email. The room opens 30 minutes before the start.</p>
        <div className="row between"><Button onClick={() => setStep(3)}>Back</Button><Button variant="primary" busy={busy} onClick={submit}>Schedule & send invitation</Button></div></Card>}
    </div>
  );
}

export function InterviewDetail() {
  const { id } = useParams(); const { can } = useAuth(); const toast = useToast(); const { confirm, node } = useConfirm();
  const { data: i, error, reload } = useLoad(() => get(`/interviews/${id}`), [id]);
  const [dev, setDev] = useState(''); const [resched, setResched] = useState(false); const [transcript, setTranscript] = useState(''); const [ai, setAi] = useState<any[]>([]); const [busy, setBusy] = useState('');
  const loadAi = () => get(`/interviews/${id}/ai-reports`).then(r => setAi(r.items)).catch(() => {});
  useEffect(() => { void loadAi(); }, [id]);
  if (error) return <ErrorBox error={error} />;
  if (!i) return <Loading />;
  const closed = ['completed', 'cancelled'].includes(i.status);
  const runAi = async (kind: string, body: any = {}) => { setBusy(kind); try { await post(`/interviews/${id}/ai/${kind}`, body); await loadAi(); toast('AI draft created. Review and edit before use.'); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); } };
  return (
    <div className="stack">
      <div className="row between"><div><h1 style={{ marginBottom: 2 }}>{i.title}</h1><div className="muted"><Link to={`/candidates/${i.candidate.candidate_id}`}>{i.candidate.name}</Link> · {i.candidate.job_title} · Round {i.round_no} {statusBadge(i.status)}</div></div>
        <div className="row">{i.mayJoin && !['cancelled'].includes(i.status) && <Link className="btn primary" to={`/interviews/${id}/room`}>{i.status === 'completed' ? 'Re-open room' : 'Open interview room'}</Link>}
          {i.status === 'completed' && <Link className="btn" to={`/interviews/${id}/feedback`}>Feedback</Link>}{can('recordings.view') && i.status !== 'scheduled' && <Link className="btn" to={`/interviews/${id}/playback`}>Playback & timeline</Link>}</div></div>
      {dev && <div className="alert">Dev invite link: <a href={dev}>{dev}</a></div>}
      <div className="grid g2">
        <Card title="Schedule"><table><tbody><tr><th>When</th><td>{fmtDate(i.scheduled_at)} ({i.timezone})</td></tr><tr><th>Duration</th><td>{i.duration_min} min</td></tr><tr><th>Type</th><td>{i.type.replace('_', ' ')}</td></tr>
          <tr><th>Tools</th><td>{[i.config.coding && 'coding', i.config.whiteboard !== false && 'whiteboard', i.config.recording && 'recording', i.config.secondaryCamera && 'secondary camera'].filter(Boolean).join(', ')}</td></tr></tbody></table>
          {i.instructions && <p><b>Instructions:</b> {i.instructions}</p>}
          {can('interviews.schedule') && !closed && <div className="row">
            <Button size="sm" onClick={() => setResched(true)}>Reschedule</Button>
            <Button size="sm" onClick={async () => { const r = await post(`/interviews/${id}/resend-invite`); if (r.devInviteUrl) setDev(r.devInviteUrl); toast('Invitation re-sent with a fresh link'); }}>Resend invite</Button>
            <Button size="sm" onClick={async () => { await post(`/interviews/${id}/revoke-invite`); toast('Candidate link revoked'); }}>Revoke link</Button>
            <Button size="sm" variant="danger" onClick={async () => { if (await confirm('Cancel this interview and notify the candidate?')) { await post(`/interviews/${id}/cancel`); void reload(); } }}>Cancel interview</Button></div>}
        </Card>
        <Card title="Participants"><div className="stack gap-sm">{i.participants.map((p: any) => <div key={p.id} className="row between"><span>{p.name} <span className="muted small">{p.email}</span></span><Badge>{p.role}</Badge></div>)}<div className="row between"><span>{i.candidate.name} <span className="muted small">candidate</span></span><Badge kind="info">invited</Badge></div></div></Card>
      </div>
      {can('recordings.view') && i.recordings.length > 0 && <Card title="Recordings"><table><tbody>{i.recordings.map((r: any) => <tr key={r.id}><td>{r.source}</td><td>{(r.size / 1048576).toFixed(1)} MB</td><td>{statusBadge(r.status)}</td><td>{fmtDate(r.created_at)}</td><td className="right">{can('recordings.delete') && r.status !== 'deleted' && <Button size="sm" variant="danger" onClick={async () => { if (await confirm('Permanently delete this recording?')) { await del(`/recordings/${r.id}`); void reload(); } }}>Delete</Button>}</td></tr>)}</tbody></table></Card>}
      {can('ai.use') && <Card title="Transcript & AI assistance">
        <div className="alert" style={{ marginBottom: 10 }}>AI output is a labelled draft for humans to review. It never recommends hiring or rejecting, and does not analyse faces, voices or emotions.</div>
        <Field label="Add transcript text" hint="One line per utterance, optionally 'Speaker: text'. Automatic speech-to-text needs a provider (see README)."><textarea value={transcript} onChange={e => setTranscript(e.target.value)} rows={4} /></Field>
        <div className="row" style={{ margin: '8px 0' }}>
          <Button size="sm" disabled={!transcript.trim()} onClick={async () => { const segs = transcript.split('\n').filter(l => l.trim()).map((l, n) => { const m = l.match(/^([^:]{1,40}):\s*(.+)$/); return { speaker: m ? m[1] : 'Speaker', text: m ? m[2] : l, offset_sec: n }; }); await post(`/interviews/${id}/transcript`, { segments: segs }); setTranscript(''); toast('Transcript saved'); }}>Save transcript</Button>
          <Button size="sm" busy={busy === 'summary'} onClick={() => runAi('summary')}>✨ Summarise</Button>
          <Button size="sm" busy={busy === 'feedback-draft'} onClick={() => runAi('feedback-draft')}>✨ Draft feedback evidence</Button>
          <Button size="sm" busy={busy === 'coding-summary'} onClick={() => runAi('coding-summary')}>✨ Coding summary</Button>
        </div>
        {ai.map(r => <details key={r.id} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}><summary><Badge kind="warn">AI-generated</Badge> {r.kind.replace('_', ' ')} <span className="small muted">· {r.provider} · {fmtDate(r.created_at)}</span></summary><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{JSON.stringify(r.content, null, 2)}</pre></details>)}
      </Card>}
      {resched && <Reschedule i={i} onClose={() => setResched(false)} onDone={d => { setResched(false); if (d?.devInviteUrl) setDev(d.devInviteUrl); void reload(); }} />}
      {node}
    </div>
  );
}

function Reschedule({ i, onClose, onDone }: { i: any; onClose: () => void; onDone: (r: any) => void }) {
  const [local, setLocal] = useState(''); const [tz, setTz] = useState(i.timezone); const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title="Reschedule interview" onClose={onClose}>
      <div className="stack"><ErrorBox error={err} /><Field label="New date & time"><input type="datetime-local" value={local} onChange={e => setLocal(e.target.value)} /></Field>
        <Field label="Time zone"><select value={tz} onChange={e => setTz(e.target.value)}>{zones.map(z => <option key={z}>{z}</option>)}</select></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!local} onClick={async () => { try { onDone(await patch(`/interviews/${i.id}`, { scheduledAt: zonedToIso(local, tz), timezone: tz })); } catch (e) { setErr(e); } }}>Reschedule & notify</Button></div></div>
    </Modal>
  );
}
