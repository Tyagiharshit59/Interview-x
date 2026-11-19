import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, upload } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ChipInput, Empty, ErrorBox, Field, Loading, statusBadge, useConfirm, useLoad, useToast } from '../ui';

export function JobsList() {
  const { can } = useAuth(); const toast = useToast(); const nav = useNavigate();
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [tpl, setTpl] = useState(false);
  const { data, loading, error, reload } = useLoad(() => get(`/jobs?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(tpl ? { templates: '1' } : {}) })}`), [q, status, tpl]);
  const { confirm, node } = useConfirm();
  return (
    <div className="stack">
      <div className="row between"><h1>{tpl ? 'JD templates' : 'Jobs'}</h1>{can('jobs.write') && <Link className="btn primary" to="/jobs/new">New job</Link>}</div>
      <div className="row"><input style={{ maxWidth: 280 }} placeholder="Search title or department" value={q} onChange={e => setQ(e.target.value)} aria-label="Search jobs" />
        <select style={{ maxWidth: 180 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option><option>draft</option><option>published</option><option>archived</option></select>
        <label className="check"><input type="checkbox" checked={tpl} onChange={e => setTpl(e.target.checked)} />Templates only</label></div>
      <ErrorBox error={error} />
      <Card>{loading ? <Loading /> : !data?.items.length ? <Empty title="No jobs yet">{can('jobs.write') && <p><Link to="/jobs/new">Create your first job</Link> or upload a job description.</p>}</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Title</th><th>Department</th><th>Location</th><th>Applicants</th><th>Status</th><th /></tr></thead><tbody>
          {data.items.map((j: any) => (
            <tr key={j.id}><td><Link to={`/jobs/${j.id}`}><b>{j.title}</b></Link></td><td>{j.department || '—'}</td><td>{j.location || '—'}</td><td>{j.applicants}</td><td>{statusBadge(j.status)}</td>
              <td className="right">{can('jobs.write') && <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button size="sm" onClick={async () => { const r = await post(`/jobs/${j.id}/duplicate`); toast('Job duplicated'); nav(`/jobs/${r.id}/edit`); }}>Duplicate</Button>
                {j.status !== 'archived' ? <Button size="sm" onClick={async () => { if (await confirm(`Archive "${j.title}"?`, false)) { await post(`/jobs/${j.id}/status`, { status: 'archived' }); void reload(); } }}>Archive</Button>
                  : <Button size="sm" onClick={async () => { await post(`/jobs/${j.id}/status`, { status: 'draft' }); void reload(); }}>Restore</Button>}
              </div>}</td></tr>
          ))}</tbody></table></div>)}</Card>
      {node}
    </div>
  );
}

const blank = { title: '', department: '', location: '', employment_type: 'full-time', exp_min: '' as any, exp_max: '' as any, description: '', responsibilities: '', qualifications: '', required_skills: [] as string[], preferred_skills: [] as string[], screening_questions: [] as string[], interviewer_ids: [] as string[], is_template: false };

export function JobEditor() {
  const { id } = useParams(); const nav = useNavigate(); const toast = useToast(); const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<any>(blank); const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false); const [parsing, setParsing] = useState(false);
  const { data: team } = useLoad(() => get('/team'));
  const { data: templates } = useLoad(() => get('/jobs?templates=1'));
  useEffect(() => { if (id) get(`/jobs/${id}`).then(j => setF({ ...blank, ...j, exp_min: j.exp_min ?? '', exp_max: j.exp_max ?? '' })).catch(setErr); }, [id]);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  const save = async (publish = false) => {
    setBusy(true); setErr(null);
    const body = { ...f, exp_min: f.exp_min === '' ? null : Number(f.exp_min), exp_max: f.exp_max === '' ? null : Number(f.exp_max) };
    delete body.id; delete body.company_id; delete body.status; delete body.created_at; delete body.updated_at; delete body.created_by; delete body.applicants;
    try {
      const r = id ? await patch(`/jobs/${id}`, body) : await post('/jobs', body);
      if (publish) await post(`/jobs/${r.id}/status`, { status: 'published' });
      toast(publish ? 'Job published' : 'Job saved'); nav(`/jobs/${r.id}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const onFile = async (file?: File | null) => {
    if (!file) return; setParsing(true); setErr(null);
    try { const r = await upload('/jobs/parse', file); const p = r.parsed; setF((prev: any) => ({ ...prev, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) })); toast('Extracted fields. Please review them.'); }
    catch (x) { setErr(x); } finally { setParsing(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  return (
    <form className="stack" onSubmit={e => { e.preventDefault(); void save(false); }}>
      <div className="row between"><h1>{id ? 'Edit job' : 'New job'}</h1><Link to="/jobs">Cancel</Link></div>
      {err && !err.details && <ErrorBox error={err} />}
      {!id && (
        <Card title="Quick start">
          <div className="row">
            <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt" style={{ display: 'none' }} onChange={e => onFile(e.target.files?.[0])} aria-label="Upload job description" />
            <Button type="button" busy={parsing} onClick={() => fileRef.current?.click()}>⬆ Upload JD (PDF / DOC / DOCX)</Button>
            {templates?.items.length > 0 && <select style={{ maxWidth: 260 }} defaultValue="" onChange={e => { const t = templates.items.find((x: any) => x.id === e.target.value); if (t) setF({ ...blank, ...t, is_template: false, id: undefined, exp_min: t.exp_min ?? '', exp_max: t.exp_max ?? '' }); }} aria-label="Start from template"><option value="">Start from a template…</option>{templates.items.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>We extract title, skills, experience and sections automatically. Always review the result.</p>
        </Card>
      )}
      <Card title="Basics">
        <div className="grid g2">
          <Field label="Job title" error={fe('title')}><input required value={f.title} onChange={e => set('title', e.target.value)} /></Field>
          <Field label="Department"><input value={f.department || ''} onChange={e => set('department', e.target.value)} /></Field>
          <Field label="Location"><input value={f.location || ''} onChange={e => set('location', e.target.value)} /></Field>
          <Field label="Employment type"><select value={f.employment_type || ''} onChange={e => set('employment_type', e.target.value)}><option value="full-time">Full-time</option><option value="part-time">Part-time</option><option value="contract">Contract</option><option value="internship">Internship</option></select></Field>
          <Field label="Min experience (years)"><input type="number" min={0} value={f.exp_min} onChange={e => set('exp_min', e.target.value)} /></Field>
          <Field label="Max experience (years)"><input type="number" min={0} value={f.exp_max} onChange={e => set('exp_max', e.target.value)} /></Field>
        </div>
      </Card>
      <Card title="Skills">
        <div className="grid g2"><Field label="Required skills" hint="Used for the transparent skill-match aid"><ChipInput value={f.required_skills} onChange={v => set('required_skills', v)} /></Field>
          <Field label="Preferred skills"><ChipInput value={f.preferred_skills} onChange={v => set('preferred_skills', v)} /></Field></div>
      </Card>
      <Card title="Details">
        <div className="stack">
          <Field label="Description"><textarea rows={6} value={f.description || ''} onChange={e => set('description', e.target.value)} /></Field>
          <Field label="Responsibilities"><textarea rows={4} value={f.responsibilities || ''} onChange={e => set('responsibilities', e.target.value)} /></Field>
          <Field label="Qualifications"><textarea rows={3} value={f.qualifications || ''} onChange={e => set('qualifications', e.target.value)} /></Field>
          <Field label="Screening questions" hint="Press Enter after each question"><ChipInput value={f.screening_questions} onChange={v => set('screening_questions', v)} placeholder="e.g. Are you able to relocate?" /></Field>
        </div>
      </Card>
      <Card title="Hiring team">
        <Field label="Default interviewers"><select multiple value={f.interviewer_ids} onChange={e => set('interviewer_ids', [...e.target.selectedOptions].map(o => o.value))} style={{ minHeight: 110 }}>
          {team?.members.filter((m: any) => m.status === 'active').map((m: any) => <option key={m.user_id} value={m.user_id}>{m.name} ({m.role.replace('_', ' ')})</option>)}</select></Field>
        <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={f.is_template} onChange={e => set('is_template', e.target.checked)} />Save as a reusable template</label>
      </Card>
      <div className="row"><Button variant="primary" busy={busy} type="submit">Save draft</Button>{!f.is_template && <Button busy={busy} type="button" onClick={() => save(true)}>Save & publish</Button>}</div>
    </form>
  );
}

export function JobDetail() {
  const { id } = useParams(); const { can } = useAuth(); const toast = useToast();
  const { data: job, error } = useLoad(() => get(`/jobs/${id}`), [id]);
  const { data: pipe, reload } = useLoad(() => get(`/jobs/${id}/pipeline`), [id]);
  const [over, setOver] = useState<string | null>(null); const [ai, setAi] = useState<any>(null); const [aiBusy, setAiBusy] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!job || !pipe) return <Loading />;
  const move = async (appId: string, stage: string) => { try { await patch(`/applications/${appId}/stage`, { stage }); void reload(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <div className="stack">
      <div className="row between"><div><h1 style={{ marginBottom: 2 }}>{job.title}</h1><div className="muted">{[job.department, job.location, job.employment_type].filter(Boolean).join(' · ')} {statusBadge(job.status)}</div></div>
        <div className="row">{can('jobs.write') && <><Link className="btn" to={`/jobs/${id}/edit`}>Edit</Link>{job.status !== 'published' && <Button variant="primary" onClick={async () => { await post(`/jobs/${id}/status`, { status: 'published' }); location.reload(); }}>Publish</Button>}</>}
          {can('ai.use') && <Button busy={aiBusy} onClick={async () => { setAiBusy(true); try { setAi(await post('/ai/questions', { jobId: id, count: 8 })); } catch (e: any) { toast(e.message, 'error'); } finally { setAiBusy(false); } }}>✨ Suggest interview questions</Button>}</div></div>
      <div className="row">{job.required_skills.map((s: string) => <span className="chip" key={s}>{s}</span>)}{job.preferred_skills.map((s: string) => <span className="chip gray" key={s}>{s}</span>)}</div>
      {ai && <Card title="Suggested questions"><div className="alert warn" style={{ marginBottom: 10 }}>🤖 AI-generated ({ai.provider}). {ai.disclaimer}</div><ol>{ai.content.questions.map((q: any, i: number) => <li key={i}><b>{q.question}</b><div className="small muted">{q.why}</div></li>)}</ol></Card>}
      <Card title="Pipeline" actions={can('candidates.write') && <Link className="btn sm" to={`/candidates?add=1&jobId=${id}`}>Add candidate</Link>}>
        <p className="small muted">Drag cards between stages. Match scores are keyword-based decision support only. Final "Selected"/"Rejected" decisions need a hiring manager or admin.</p>
        <div className="kanban">{pipe.stages.map((s: string) => {
          const items = pipe.items.filter((a: any) => a.stage === s);
          return (
            <div key={s} className={`col ${over === s ? 'over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(s); }} onDragLeave={() => setOver(null)}
              onDrop={e => { e.preventDefault(); setOver(null); const a = e.dataTransfer.getData('text/plain'); if (a) void move(a, s); }}>
              <h4>{s}<span>{items.length}</span></h4>
              {items.map((a: any) => (
                <div key={a.id} className="kcard" draggable={can('candidates.write')} onDragStart={e => e.dataTransfer.setData('text/plain', a.id)}>
                  <Link to={`/candidates/${a.candidate_id}`}><b>{a.name}</b></Link>
                  <div className="small muted">{a.current_title || a.email}</div>
                  <div className="row gap-sm" style={{ marginTop: 6 }}>{a.match_score != null && <Badge kind={a.match_score >= 70 ? 'ok' : a.match_score >= 40 ? 'warn' : undefined}>Skill match {a.match_score}%</Badge>}
                    {can('candidates.write') && <select aria-label={`Move ${a.name}`} style={{ minHeight: 28, padding: '2px 6px', width: 'auto', fontSize: '.8rem' }} value={a.stage} onChange={e => move(a.id, e.target.value)}>{pipe.stages.map((x: string) => <option key={x}>{x}</option>)}</select>}</div>
                </div>))}
            </div>);
        })}</div>
      </Card>
      {job.description && <Card title="Description"><div style={{ whiteSpace: 'pre-wrap' }}>{job.description}</div></Card>}
    </div>
  );
}
export { del };
