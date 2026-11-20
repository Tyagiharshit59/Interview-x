import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { del, fmtDate, get, patch, post, upload } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ChipInput, Empty, ErrorBox, Field, Loading, Modal, statusBadge, useConfirm, useLoad, useToast, PageHeader } from '../ui';

export function CandidatesList() {
  const { can } = useAuth(); const [sp] = useSearchParams(); const toast = useToast();
  const [q, setQ] = useState(''); const [skill, setSkill] = useState(''); const [stage, setStage] = useState(''); const [add, setAdd] = useState(sp.get('add') === '1'); const [imp, setImp] = useState(false);
  const { data, loading, error, reload } = useLoad(() => get(`/candidates?${new URLSearchParams({ ...(q ? { q } : {}), ...(skill ? { skill } : {}), ...(stage ? { stage } : {}) })}`), [q, skill, stage]);
  return (
    <div className="stack">
      <PageHeader eyebrow="Hiring" title="Candidates" description="Everyone in your talent pool, with parsed CVs, skills and activity." actions={can('candidates.write') && <><Button onClick={() => setImp(true)}>Import CSV</Button><Button variant="primary" onClick={() => setAdd(true)}>Add candidate</Button></>} />
      <div className="row"><input style={{ maxWidth: 260 }} placeholder="Search name, email, title" value={q} onChange={e => setQ(e.target.value)} aria-label="Search candidates" />
        <input style={{ maxWidth: 160 }} placeholder="Skill" value={skill} onChange={e => setSkill(e.target.value)} aria-label="Filter by skill" />
        <input style={{ maxWidth: 180 }} placeholder="Stage (e.g. Shortlisted)" value={stage} onChange={e => setStage(e.target.value)} aria-label="Filter by stage" /></div>
      <ErrorBox error={error} />
      <Card>{loading ? <Loading /> : !data?.items.length ? <Empty title="No candidates found">Add one manually, upload a CV, or import a CSV.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Current role</th><th>Experience</th><th>Skills</th><th>Applications</th><th>Added</th></tr></thead><tbody>
          {data.items.map((c: any) => <tr key={c.id}><td><Link to={`/candidates/${c.id}`}><b>{c.name}</b></Link><div className="small muted">{c.email}</div></td><td>{c.current_title || '—'}</td><td>{c.experience_years != null ? `${c.experience_years} yrs` : '—'}</td>
            <td><div className="chips">{c.skills.slice(0, 4).map((s: string) => <span className="chip gray" key={s}>{s}</span>)}{c.skills.length > 4 && <span className="muted small">+{c.skills.length - 4}</span>}</div></td><td>{c.applications}</td><td className="small muted">{fmtDate(c.created_at, { dateStyle: 'medium' })}</td></tr>)}
        </tbody></table></div>)}</Card>
      {add && <AddCandidate defaultJob={sp.get('jobId') || ''} onClose={() => setAdd(false)} onDone={() => { setAdd(false); void reload(); toast('Candidate added'); }} />}
      {imp && <ImportCsv onClose={() => setImp(false)} onDone={n => { setImp(false); void reload(); toast(`Imported ${n.created} candidate(s)${n.skipped.length ? `, skipped ${n.skipped.length} duplicate(s)` : ''}`); }} />}
    </div>
  );
}

function AddCandidate({ onClose, onDone, defaultJob }: { onClose: () => void; onDone: () => void; defaultJob: string }) {
  const [f, setF] = useState<any>({ name: '', email: '', phone: '', current_title: '', experience_years: '', skills: [], jobId: defaultJob, invite_to_portal: true });
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false); const file = useRef<File | null>(null);
  const { data: jobs } = useLoad(() => get('/jobs'));
  const prefill = async (fl?: File | null) => {
    if (!fl) return; file.current = fl;
    try { const { parsed } = await upload('/candidates/parse-resume', fl); setF((p: any) => ({ ...p, name: p.name || parsed.name || '', email: p.email || parsed.email || '', phone: p.phone || parsed.phone || '', experience_years: p.experience_years || parsed.experience_years || '', skills: [...new Set([...p.skills, ...parsed.skills])] })); } catch (e) { setErr(e); }
  };
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  return (
    <Modal title="Add candidate" onClose={onClose} wide>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          const c = await post('/candidates', { ...f, experience_years: f.experience_years === '' ? null : Number(f.experience_years), jobId: f.jobId || null });
          if (file.current) await upload(`/candidates/${c.id}/resume`, file.current);
          if (c.portalInvite?.devInviteUrl) window.prompt('Development only (email not configured): profile invitation link for the candidate', c.portalInvite.devInviteUrl);
          onDone();
        } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        {err && !err.details && <ErrorBox error={err} />}
        <label className="check rounded-xl border border-brand-200/60 bg-brand-500/[0.05] p-3 dark:border-brand-800"><input type="checkbox" checked={f.invite_to_portal} onChange={e => setF({ ...f, invite_to_portal: e.target.checked })} /><span><b>Invite to complete their profile</b><br /><span className="muted small">We email a secure link so the candidate can set a password on IntervueX Careers, upload their CV, track this application and join interviews.</span></span></label>
        <Field label="Resume (optional)" hint="PDF, DOC, DOCX or TXT up to 8 MB. We pre-fill details; please review."><input type="file" accept=".pdf,.doc,.docx,.txt" onChange={e => prefill(e.target.files?.[0])} /></Field>
        <div className="grid g2">
          <Field label="Full name" error={fe('name')}><input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email" error={fe('email')}><input type="email" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone"><input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Current title"><input value={f.current_title} onChange={e => setF({ ...f, current_title: e.target.value })} /></Field>
          <Field label="Years of experience"><input type="number" min={0} step="0.5" value={f.experience_years} onChange={e => setF({ ...f, experience_years: e.target.value })} /></Field>
          <Field label="Apply to job"><select value={f.jobId} onChange={e => setF({ ...f, jobId: e.target.value })}><option value="">— none —</option>{jobs?.items.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></Field>
        </div>
        <Field label="Skills"><ChipInput value={f.skills} onChange={v => setF({ ...f, skills: v })} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} type="submit">Add candidate</Button></div>
      </form>
    </Modal>
  );
}

function ImportCsv({ onClose, onDone }: { onClose: () => void; onDone: (r: any) => void }) {
  const [rows, setRows] = useState<any[]>([]); const [err, setErr] = useState<unknown>(null); const [jobId, setJobId] = useState('');
  const { data: jobs } = useLoad(() => get('/jobs'));
  const parse = async (f?: File | null) => {
    if (!f) return; const text = await f.text();
    const lines = text.split(/\r?\n/).filter(Boolean); const head = lines[0].split(',').map(h => h.trim().toLowerCase());
    setRows(lines.slice(1).map(l => { const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()) || []; return Object.fromEntries(head.map((h, i) => [h, cells[i]])); }).filter(r => r.email && r.name));
  };
  return (
    <Modal title="Import candidates from CSV" onClose={onClose}>
      <div className="stack"><ErrorBox error={err} />
        <p className="small muted" style={{ margin: 0 }}>Columns: <span className="mono">name, email, phone, current_title, skills</span> (skills separated by ; or |). Up to 500 rows.</p>
        <input type="file" accept=".csv,text/csv" onChange={e => parse(e.target.files?.[0])} aria-label="CSV file" />
        <Field label="Add to job (optional)"><select value={jobId} onChange={e => setJobId(e.target.value)}><option value="">— none —</option>{jobs?.items.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}</select></Field>
        {rows.length > 0 && <div className="alert">{rows.length} valid row(s) ready. First: {rows[0].name} ({rows[0].email})</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!rows.length} onClick={async () => { try { onDone(await post('/candidates/import', { rows, jobId: jobId || null })); } catch (e) { setErr(e); } }}>Import</Button></div></div>
    </Modal>
  );
}

export function CandidateProfile() {
  const [shareApp, setShareApp] = useState<any>(null);
  const { id } = useParams(); const { can, me } = useAuth(); const toast = useToast(); const nav = useNavigate(); const { confirm, node } = useConfirm();
  const { data, error, reload } = useLoad(() => get(`/candidates/${id}`), [id]);
  const { data: jobs } = useLoad(() => get('/jobs'));
  const [note, setNote] = useState(''); const [notes, setNotes] = useState<any[]>([]); const [activeApp, setActiveApp] = useState<string | null>(null); const fileRef = useRef<HTMLInputElement>(null);
  const [decide, setDecide] = useState<any>(null);
  const loadNotes = async (appId: string) => { setActiveApp(appId); setNotes((await get(`/applications/${appId}/notes`)).items); };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const c = data.candidate;
  const openResume = async (rid: string) => { const r = await post(`/candidates/${id}/resumes/${rid}/link`); window.open(r.url, '_blank'); };
  return (
    <div className="stack">
      <div className="row between"><div><h1 style={{ marginBottom: 2 }}>{c.name}</h1><div className="muted">{c.current_title || 'Candidate'} · {c.email}{c.phone ? ` · ${c.phone}` : ''}</div></div>
        <div className="row">{can('candidates.write') && ['owner', 'admin'].includes(me?.role || '') && <Button variant="danger" size="sm" onClick={async () => { if (await confirm('Permanently delete this candidate, their resumes, interviews and recordings? This cannot be undone.')) { await del(`/candidates/${id}`); toast('Candidate data deleted'); nav('/candidates'); } }}>Delete data</Button>}</div></div>
      <PortalInviteBar candidateId={id!} />
      <div className="chips">{c.skills.map((s: string) => <span key={s} className="chip">{s}</span>)}{c.experience_years != null && <Badge>{c.experience_years} yrs experience</Badge>}</div>
      <div className="grid g2">
        <Card title="Resumes" actions={can('candidates.write') && <><input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const r = await upload(`/candidates/${id}/resume`, f); toast(`Uploaded. Found ${r.extractedSkills.length} skills.`); void reload(); } catch (x: any) { toast(x.message, 'error'); } }} /><Button size="sm" onClick={() => fileRef.current?.click()}>Upload</Button></>}>
          {data.resumes.length ? data.resumes.map((r: any) => <div key={r.id} className="row between"><span>📄 {r.original_name} <span className="muted small">{fmtDate(r.uploaded_at)}</span></span><Button size="sm" onClick={() => openResume(r.id)}>Open</Button></div>) : <div className="muted">No resume uploaded.</div>}
        </Card>
        <Card title="Applications" actions={can('candidates.write') && <select aria-label="Apply to job" style={{ width: 170 }} value="" onChange={async e => { if (e.target.value) { await post(`/candidates/${id}/applications`, { jobId: e.target.value }); void reload(); } }}><option value="">+ Add to job…</option>{jobs?.items.filter((j: any) => !data.applications.some((a: any) => a.job_id === j.id)).map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}</select>}>
          {data.applications.length ? data.applications.map((a: any) => (
            <div key={a.id} className="stack gap-sm" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row between"><Link to={`/jobs/${a.job_id}`}><b>{a.job_title}</b></Link><Badge kind="info">{a.stage}</Badge></div>
              {a.match_score != null && <details><summary className="small">Skill match: <b>{a.match_score}%</b> (decision support only)</summary><div className="small muted">Matched: {a.match_detail?.matchedRequired.join(', ') || '—'}<br />Missing: {a.match_detail?.missingRequired.join(', ') || '—'}<br />{a.match_detail?.experienceNote}<br /><i>{a.match_detail?.disclaimer}</i></div></details>}
              <div className="row gap-sm"><Button size="sm" onClick={() => loadNotes(a.id)}>Notes</Button>{can('interviews.schedule') && <Link className="btn sm" to={`/interviews/new?applicationId=${a.id}`}>Schedule interview</Link>}{can('decision.make') && <Button size="sm" onClick={() => setDecide(a)}>Record decision</Button>}{can('candidates.write') && <Button size="sm" onClick={() => setShareApp(a)}>Share update with candidate</Button>}</div>
              {a.decision && <div className="small">Decision: <b>{a.decision.replace('_', ' ')}</b>{a.decision_note ? ` — ${a.decision_note}` : ''}</div>}
            </div>)) : <div className="muted">Not attached to any job yet.</div>}
        </Card>
      </div>
      {shareApp && <ShareUpdate app={shareApp} onClose={() => setShareApp(null)} />}
      {activeApp && <Card title="Notes" actions={<Button size="sm" onClick={() => setActiveApp(null)}>Close</Button>}>
        <form className="row" onSubmit={async e => { e.preventDefault(); if (!note.trim()) return; await post(`/applications/${activeApp}/notes`, { body: note }); setNote(''); void loadNotes(activeApp); }}><input className="grow" value={note} onChange={e => setNote(e.target.value)} placeholder="Add an internal note" aria-label="Note" /><Button variant="primary" type="submit">Add</Button></form>
        {notes.map(n => <div key={n.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><b>{n.author}</b> <span className="small muted">{fmtDate(n.created_at)}</span><div>{n.body}</div></div>)}</Card>}
      <div className="grid g2">
        <Card title="Interviews">{data.interviews.length ? <table><tbody>{data.interviews.map((i: any) => <tr key={i.id}><td><Link to={`/interviews/${i.id}`}>Round {i.round_no}: {i.title}</Link></td><td>{fmtDate(i.scheduled_at)}</td><td>{statusBadge(i.status)}</td></tr>)}</tbody></table> : <div className="muted">None yet.</div>}</Card>
        <Card title="Coding results">{data.coding.length ? <table><tbody>{data.coding.map((s: any) => <tr key={s.id}><td>{s.language}</td><td>{s.passed}/{s.total} tests</td><td>{s.score}%</td><td className="small muted">{fmtDate(s.created_at)}</td></tr>)}</tbody></table> : <div className="muted">No submissions.</div>}</Card>
      </div>
      {can('feedback.viewAll') && <Card title="Interviewer feedback">{data.feedback.length ? data.feedback.map((f: any, i: number) => <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><b>{f.interviewer}</b> <Badge kind={f.recommendation?.includes('hire') && f.recommendation !== 'no_hire' ? 'ok' : 'warn'}>{f.recommendation?.replace('_', ' ')}</Badge><div className="small">{f.evidence}</div></div>) : <div className="muted">No submitted feedback yet.</div>}</Card>}
      {can('recordings.view') && data.recordings.length > 0 && <Card title="Recordings">{[...new Set(data.recordings.map((r: any) => r.interview_id))].map((iid: any) => <div key={iid}><Link to={`/interviews/${iid}/playback`}>▶ Open recording & timeline</Link></div>)}</Card>}
      <Card title="Activity"><div className="stack gap-sm">{data.activity.map((a: any, i: number) => <div key={i} className="small"><span className="muted">{fmtDate(a.created_at)}</span> · {a.action.replace('.', ' ')} {a.detail && `— ${a.detail}`}</div>)}</div></Card>
      {decide && <DecisionModal app={decide} onClose={() => setDecide(null)} onDone={() => { setDecide(null); void reload(); }} />}
      {node}
    </div>
  );
}

function DecisionModal({ app, onClose, onDone }: { app: any; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState('selected'); const [n, setN] = useState(''); const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={`Decision: ${app.job_title}`} onClose={onClose}>
      <div className="stack"><div className="alert">Hiring decisions are made by people. AI scores and skill-match percentages never decide outcomes.</div><ErrorBox error={err} />
        <Field label="Decision"><select value={d} onChange={e => setD(e.target.value)}><option value="selected">Selected</option><option value="on_hold">On hold</option><option value="rejected">Rejected</option></select></Field>
        <Field label="Reasoning (based on interview evidence)"><textarea value={n} onChange={e => setN(e.target.value)} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { try { await post(`/applications/${app.id}/decision`, { decision: d, note: n }); onDone(); } catch (e) { setErr(e); } }}>Save decision</Button></div></div>
    </Modal>
  );
}
export { patch };

/** Lets the hiring team send a message the candidate sees in their careers portal (and by email). Internal notes stay internal. */
function ShareUpdate({ app, onClose }: { app: any; onClose: () => void }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => get(`/applications/${app.id}/updates`), [app.id]);
  const [msg, setMsg] = useState(''); const [kind, setKind] = useState<'update' | 'feedback'>('update'); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={`Share with the candidate · ${app.job_title}`} onClose={onClose} wide>
      <div className="stack">
        <div className="alert">This message is visible to the candidate in their IntervueX Careers portal and sent by email. Interviewer scorecards and internal notes are never shared.{data && !data.candidateHasPortal && <> The candidate has no verified portal account yet, so they will receive it by email.</>}</div>
        <form className="stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(null); try { await post(`/applications/${app.id}/updates`, { message: msg, kind }); setMsg(''); toast('Shared with the candidate'); void reload(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
          <div className="row">{(['update', 'feedback'] as const).map(k => <label key={k} className="check"><input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />{k === 'update' ? 'Status update' : 'Interview feedback'}</label>)}</div>
          <Field label="Message"><textarea required minLength={5} value={msg} onChange={e => setMsg(e.target.value)} placeholder={kind === 'feedback' ? 'Thank you for your time. You showed strong problem-solving… One area to grow is…' : 'Thanks for applying! We are reviewing your profile and will get back to you this week.'} /></Field>
          <ErrorBox error={err} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><Button variant="primary" busy={busy} type="submit">Share with candidate</Button></div>
        </form>
        {data?.items.length > 0 && <div className="stack gap-sm"><b>Previously shared</b>{data.items.map((u: any) => <div key={u.id} className="rounded-xl border border-line p-3 text-[14px]"><div className="mb-1 flex items-center gap-2"><Badge kind={u.kind === 'feedback' ? 'gold' as any : 'info'}>{u.kind === 'feedback' ? 'Feedback' : 'Update'}</Badge><span className="small muted">{u.author_name} · {fmtDate(u.created_at)}</span></div><div style={{ whiteSpace: 'pre-wrap' }}>{u.message}</div></div>)}</div>}
      </div>
    </Modal>
  );
}

/** Shows whether the candidate has joined IntervueX Careers, and lets HR send or resend the profile invitation. */
function PortalInviteBar({ candidateId }: { candidateId: string }) {
  const { can } = useAuth(); const toast = useToast();
  const { data, reload } = useLoad(() => get(`/candidates/${candidateId}/portal`), [candidateId]);
  if (!data) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft">
      <div className="text-[14px]"><b>Candidate profile:</b>{' '}
        {data.joined ? <span className="text-ok">joined IntervueX Careers{data.joinedAt ? ` on ${fmtDate(data.joinedAt, { dateStyle: 'medium' })}` : ''}. They can see shared updates and join interviews.</span>
          : data.invitedAt ? <span className="text-muted">invitation sent {fmtDate(data.invitedAt, { dateStyle: 'medium' })}, not completed yet.</span>
          : <span className="text-muted">not invited yet.</span>}
      </div>
      {!data.joined && can('candidates.write') && <Button size="sm" variant={data.invitedAt ? undefined : 'primary'} onClick={async () => { try { const r = await post(`/candidates/${candidateId}/portal-invite`); toast(r.existingAccount ? 'They already have a profile; we let them know' : 'Profile invitation sent'); if (r.devInviteUrl) window.prompt('Development only (email not configured): invitation link', r.devInviteUrl); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>{data.invitedAt ? 'Resend invitation' : 'Invite to complete profile'}</Button>}
    </div>
  );
}
