import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Gift, Send, MapPin, Briefcase, Users, Trophy, Wallet, Hourglass, CheckCircle2, XCircle, Upload, FileText, Search, UserPlus, Settings2, IndianRupee, Mail } from 'lucide-react';
import { get, patch, post, postForm, put, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, useLoad, useToast } from '../ui';
import { AddMember } from './Team';

const inr = (n: number | null | undefined) => '₹' + Number(n || 0).toLocaleString('en-IN');
const REL: Record<string, string> = { former_colleague: 'Former colleague', friend: 'Friend', classmate: 'Classmate', family: 'Family', professional_network: 'Professional network', other: 'Other' };
const BONUS_TONE: Record<string, any> = { pending: undefined, pending_waiting: 'info', eligible: 'gold', paid: 'ok', not_eligible: undefined, declined: 'danger' };

/* ---------------- Refer & earn (every company member, incl. employees) ---------------- */
export function ReferHome() {
  const { data, error } = useLoad(() => get('/referrals/jobs'));
  const [q, setQ] = useState(''); const [job, setJob] = useState<any>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const p = data.program;
  const jobs = data.items.filter((j: any) => !q || `${j.job_code ?? ''} ${j.title} ${j.department ?? ''} ${j.location ?? ''} ${j.required_skills.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-6">
      <div className="relative overflow-hidden rounded-3xl bg-night-gradient p-7 text-white shadow-lift sm:p-9">
        <div className="pointer-events-none absolute -right-16 -top-20 h-72 w-72 rounded-full bg-gold-400/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-10 h-64 w-64 rounded-full bg-brand-500/30 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-300">Employee referral programme</div>
            <h1 className="mb-0 mt-2 font-display text-[2.2rem] font-semibold leading-tight text-white sm:text-[2.8rem]">Know someone great? <span className="bg-gold-gradient bg-clip-text italic text-transparent">Refer & earn.</span></h1>
            <p className="mb-0 mt-3 text-[15px] text-slate-300">Bonuses up to <b className="text-gold-200">{inr(Math.max(p.defaultBonus, ...data.items.map((x: any) => x.bonus), 0))}</b> when the person you refer is hired{p.payoutAfterDays ? ` and completes ${p.payoutAfterDays} days` : ''}.</p>
          </div>
          <Link to="/referrals/mine" className="btn gold !min-h-[48px] !rounded-2xl">My referrals</Link>
        </div>
      </div>
      {!p.enabled ? <div className="alert warn">The referral programme is paused right now. Check back soon.</div> : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="mb-0 text-xl">Open roles <span className="text-[15px] font-medium text-muted">({data.items.length})</span></h2>
            <div className="relative sm:w-80"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input className="!pl-10" placeholder="Search job ID, role or skill" value={q} onChange={e => setQ(e.target.value)} aria-label="Search roles" /></div>
          </div>
          {jobs.length ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {jobs.map((j: any) => (
                <article key={j.id} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lift">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">{j.job_code && <div className="font-mono text-[11.5px] font-semibold tracking-wide text-gold-600 dark:text-gold-300">{j.job_code}</div>}<div className="text-[16px] font-bold">{j.title}</div><div className="mt-0.5 text-[13px] text-muted">{j.department || 'Team'}</div></div>
                    <span className="flex-none rounded-xl bg-gold-gradient px-2.5 py-1 text-[13px] font-extrabold text-midnight-950 shadow-sm">{inr(j.bonus)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">{j.location && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{j.location}</span>}{j.employment_type && <span className="flex items-center gap-1 capitalize"><Briefcase className="h-3.5 w-3.5" />{j.employment_type}</span>}{(j.exp_min != null) && <span>{j.exp_min}{j.exp_max != null ? `–${j.exp_max}` : '+'} yrs</span>}</div>
                  {j.required_skills.length > 0 && <div className="chips">{j.required_skills.slice(0, 5).map((s: string) => <span key={s} className="chip gray">{s}</span>)}</div>}
                  {j.description && <p className="mb-0 line-clamp-2 text-[13.5px] text-muted">{j.description}</p>}
                  <Button variant="primary" className="mt-auto" onClick={() => setJob(j)}><Send className="h-4 w-4" />Refer someone</Button>
                </article>
              ))}
            </div>
          ) : <Empty title={data.items.length ? 'No roles match your search' : 'No open roles right now'} icon={<Briefcase className="h-6 w-6" />}>New openings appear here as soon as they're published.</Empty>}
          <p className="text-[12.5px] text-muted"><b>Programme terms:</b> {p.terms}</p>
        </>
      )}
      {job && <ReferModal job={job} onClose={() => setJob(null)} />}
    </div>
  );
}

function ReferModal({ job, onClose }: { job: any; onClose: () => void }) {
  const toast = useToast(); const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ name: '', email: '', phone: '', relationship: 'former_colleague', linkedin: '', note: '' });
  const [cv, setCv] = useState<File | null>(null); const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const fd = new FormData(); fd.append('job_id', job.id); for (const [k, v] of Object.entries(f)) if (v) fd.append(k, v); fd.append('consent', String(consent)); if (cv) fd.append('cv', cv);
    try { await postForm('/referrals', fd); setDone(true); toast('Referral submitted'); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (done) return (
    <Modal title="Referral submitted" onClose={onClose}>
      <div className="flex flex-col items-center gap-3 py-2 text-center"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-gold-gradient text-midnight-950 shadow"><Gift className="h-7 w-7" /></span>
        <p className="mb-0">Thank you! <b>{f.name}</b> has been referred for <b>{job.title}</b>. HR will review the profile, and you can follow progress in My referrals. You'll earn <b>{inr(job.bonus)}</b> if they're hired.</p></div>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={onClose}>Refer another</Button><Link to="/referrals/mine" className="btn primary">My referrals</Link></div>
    </Modal>
  );
  return (
    <Modal title={`Refer for ${job.title}`} onClose={onClose} wide>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-gold-400/40 bg-gold-400/10 p-4"><span className="text-[14px]">Referral bonus for this role</span><b className="text-xl text-gold-600 dark:text-gold-300">{inr(job.bonus)}</b></div>
        {err && !err.details && <ErrorBox error={err} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Candidate's full name" error={fe('name')}><input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Candidate's email" error={fe('email')}><input type="email" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Phone" hint="Optional"><input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="How do you know them?"><select value={f.relationship} onChange={e => setF({ ...f, relationship: e.target.value })}>{Object.entries(REL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="LinkedIn profile" hint="Optional"><input value={f.linkedin} onChange={e => setF({ ...f, linkedin: e.target.value })} placeholder="linkedin.com/in/…" /></Field>
          <div className="flex flex-col gap-1.5 text-[13px] font-semibold"><span>CV</span>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.txt" className="hidden" onChange={e => setCv(e.target.files?.[0] || null)} />
            <Button type="button" onClick={() => fileRef.current?.click()}>{cv ? <><FileText className="h-4 w-4" /><span className="truncate">{cv.name}</span></> : <><Upload className="h-4 w-4" />Attach CV (optional)</>}</Button>
            <span className="text-xs font-normal text-muted">PDF, DOCX or TXT · skills are extracted automatically</span></div>
        </div>
        <Field label="Why are they a great fit?" hint="Optional, but it really helps HR"><textarea value={f.note} onChange={e => setF({ ...f, note: e.target.value })} maxLength={3000} /></Field>
        <label className="check rounded-xl bg-raised/60 p-3"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required /><span>I confirm this person knows I'm referring them and agreed to share their details with our hiring team.</span></label>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" busy={busy} disabled={!consent}><Send className="h-4 w-4" />Submit referral</Button></div>
      </form>
    </Modal>
  );
}

/* ---------------- My referrals ---------------- */
const STEPS = ['Referred', 'In review', 'Interviewing', 'Outcome'];
export function MyReferrals() {
  const { data } = useLoad(() => get('/referrals/mine'));
  if (!data) return <Loading />;
  const s = data.summary;
  const tile = (label: string, value: string | number, Icon: any, tone: string) => (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 shadow-soft"><span className={`grid h-11 w-11 place-items-center rounded-xl text-white ${tone}`}><Icon className="h-5 w-5" /></span><div><div className="text-2xl font-extrabold leading-none">{value}</div><div className="mt-1 text-[13px] font-semibold text-muted">{label}</div></div></div>
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Refer & earn" title="My referrals" description="Follow the people you've referred and your bonus status. For privacy, you see progress only, not interview details." actions={<Link to="/referrals" className="btn primary"><Send className="h-4 w-4" />Refer someone</Link>} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tile('People referred', s.total, Users, 'bg-brand-gradient')}
        {tile('In progress', s.inProgress, Hourglass, 'bg-gradient-to-br from-sky-500 to-indigo-500')}
        {tile('Hired', s.hired, Trophy, 'bg-gradient-to-br from-emerald-500 to-teal-500')}
        {tile('Bonus paid', inr(s.paid), Wallet, 'bg-gold-gradient')}
      </div>
      {s.upcoming > 0 && <div className="alert"><Gift className="h-4 w-4" />{inr(s.upcoming)} in bonuses are on their way (waiting period or ready for payout).</div>}
      {data.items.length ? data.items.map((r: any) => (
        <article key={r.id} className="card flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500/15 to-gold-400/25 text-[14px] font-bold text-brand-700 dark:text-brand-200">{r.candidate_name.split(' ').map((x: string) => x[0]).slice(0, 2).join('').toUpperCase()}</span>
              <div><div className="text-[16px] font-bold">{r.candidate_name}</div><div className="text-[13px] text-muted">{r.job_code ? `${r.job_code} · ` : ''}{r.job_title} · {REL[r.relationship] || r.relationship} · referred {fmtDate(r.created_at, { dateStyle: 'medium' })}</div></div></div>
            <div className="flex flex-col items-end gap-1"><Badge kind={BONUS_TONE[r.bonus.status]}>{r.bonus.label}</Badge><span className="text-[13px] font-bold">{inr(r.bonus.amount)}</span></div>
          </div>
          {r.status.key === 'withdrawn' ? <Badge>Withdrawn</Badge> : (
            <div className="flex flex-wrap items-center gap-1.5">{STEPS.map((st, i) => { const cur = r.status.step === i + 1; const done = r.status.step >= i + 1; const closed = r.status.key === 'closed' && i === 3; return (
              <div key={st} className="flex items-center gap-1.5">
                <span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${closed ? 'bg-raised text-muted' : done ? (cur ? 'bg-brand-gradient text-white shadow-glow' : 'bg-brand-500/15 text-brand-600 dark:text-brand-300') : 'bg-raised text-muted'}`}>{closed ? <XCircle className="h-3.5 w-3.5" /> : done && !cur ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}</span>
                <span className={`text-[12.5px] ${cur ? 'font-semibold' : 'text-muted'}`}>{i === 3 ? (r.status.key === 'hired' ? 'Hired 🎉' : r.status.key === 'closed' ? 'Not progressing' : st) : st}</span>
                {i < 3 && <span className={`h-px w-6 sm:w-10 ${r.status.step > i + 1 ? 'bg-brand-400' : 'bg-line'}`} />}
              </div>); })}</div>
          )}
          {r.bonus.status === 'pending_waiting' && r.bonus.eligibleOn && <div className="text-[13px] text-muted">Bonus becomes payable on <b className="text-ink">{fmtDate(r.bonus.eligibleOn, { dateStyle: 'medium' })}</b>.</div>}
          {r.bonus.status === 'paid' && <div className="text-[13px] text-ok">Paid on {fmtDate(r.bonus.paid_at, { dateStyle: 'medium' })}{r.bonus.note ? ` · ${r.bonus.note}` : ''}</div>}
          {r.bonus.status === 'declined' && r.bonus.note && <div className="text-[13px] text-danger">Bonus declined: {r.bonus.note}</div>}
        </article>
      )) : <Empty title="You haven't referred anyone yet" icon={<Gift className="h-6 w-6" />}>Great people know great people. <Link to="/referrals">See open roles</Link></Empty>}
    </div>
  );
}

/* ---------------- HR: programme management ---------------- */
export function ReferralsManage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'referrals' | 'employees' | 'program'>('referrals');
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="People" title="Referral programme" description="Review employee referrals, pay bonuses, manage employee accounts and programme rules." />
      <div className="tabs" role="tablist">{([['referrals', 'Referrals'], ['employees', 'Employees'], ['program', 'Programme settings']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'referrals' && <ReferralsTable />}{tab === 'employees' && can('employees.manage') && <EmployeesTab />}{tab === 'program' && <ProgramTab />}
    </div>
  );
}

function ReferralsTable() {
  const toast = useToast();
  const { data, reload } = useLoad(() => get('/referrals'));
  const [filter, setFilter] = useState(''); const [act, setAct] = useState<null | { r: any; action: 'mark_paid' | 'decline' }>(null); const [note, setNote] = useState(''); const [amount, setAmount] = useState('');
  if (!data) return <Loading />;
  const t = data.totals;
  const rows = data.items.filter((r: any) => !filter || r.bonus.status === filter);
  const doAct = async () => { try { await patch(`/referrals/${act!.r.id}/bonus`, { action: act!.action, note: note || null, ...(act!.action === 'mark_paid' && amount ? { amount: Number(amount) } : {}) }); toast(act!.action === 'mark_paid' ? 'Marked as paid' : 'Bonus declined'); setAct(null); setNote(''); setAmount(''); void reload(); } catch (x: any) { toast(x.message, 'error'); } };
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[['Referrals', t.referrals, Users], ['Hired', t.hired, Trophy], ['Ready to pay', inr(t.toPay), Wallet], ['Paid out', inr(t.paid), CheckCircle2]].map(([l, v, I]: any) => (
          <div key={l} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 shadow-soft"><span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/10 text-brand-600 ring-1 ring-brand-500/20 dark:text-brand-300"><I className="h-5 w-5" /></span><div><div className="text-2xl font-extrabold leading-none">{v}</div><div className="mt-1 text-[13px] font-semibold text-muted">{l}</div></div></div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_300px]">
        <Card title="All referrals" actions={<select className="!w-48" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter by bonus"><option value="">All bonus states</option>{Object.entries({ pending: 'Pending outcome', pending_waiting: 'Waiting period', eligible: 'Ready for payout', paid: 'Paid', not_eligible: 'Not eligible', declined: 'Declined' }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}>
          {rows.length ? <div className="table-wrap"><table><thead><tr><th>Candidate</th><th>Role</th><th>Referred by</th><th>Pipeline</th><th>Bonus</th><th className="right">Actions</th></tr></thead><tbody>
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td><Link to={`/candidates/${r.candidate_id}`} className="font-semibold">{r.candidate_name}</Link><div className="text-[12.5px] text-muted">{REL[r.relationship]} · {fmtDate(r.created_at, { dateStyle: 'medium' })}</div>{r.note && <div className="mt-1 line-clamp-2 max-w-xs text-[12.5px] italic text-muted">“{r.note}”</div>}</td>
                <td>{r.job_code && <div className="font-mono text-[12px] font-semibold text-gold-600 dark:text-gold-300">{r.job_code}</div>}{r.job_title}</td>
                <td>{r.referrer_name}</td>
                <td><Badge kind="info">{r.stage || '—'}</Badge></td>
                <td><div className="font-bold">{inr(r.bonus.amount)}</div><Badge kind={BONUS_TONE[r.bonus.status]}>{r.bonus.label}</Badge>{r.bonus.status === 'pending_waiting' && r.bonus.eligibleOn && <div className="text-[12px] text-muted">from {fmtDate(r.bonus.eligibleOn, { dateStyle: 'medium' })}</div>}</td>
                <td className="right"><div className="flex justify-end gap-2">
                  {r.bonus.status === 'eligible' && <Button size="sm" variant="primary" onClick={() => { setAct({ r, action: 'mark_paid' }); setAmount(String(r.bonus.amount)); }}><IndianRupee className="h-3.5 w-3.5" />Mark paid</Button>}
                  {!['paid', 'declined'].includes(r.bonus.status) && <Button size="sm" onClick={() => setAct({ r, action: 'decline' })}>Decline</Button>}
                  {r.bonus.status === 'declined' && <Button size="sm" onClick={async () => { await patch(`/referrals/${r.id}/bonus`, { action: 'reopen' }); void reload(); }}>Reopen</Button>}
                </div></td>
              </tr>
            ))}
          </tbody></table></div> : <Empty title="No referrals yet" icon={<Gift className="h-6 w-6" />}>When employees refer people, they appear here and in your candidate pipeline tagged “referral”.</Empty>}
        </Card>
        <Card title="Top referrers">
          {data.leaderboard.length ? <ol className="m-0 flex list-none flex-col gap-2.5 p-0">{data.leaderboard.map((l: any, i: number) => (
            <li key={l.name + i} className="flex items-center gap-3"><span className={`grid h-8 w-8 place-items-center rounded-lg text-[13px] font-extrabold ${i === 0 ? 'bg-gold-gradient text-midnight-950' : 'bg-raised text-muted'}`}>{i + 1}</span><div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold">{l.name}</div><div className="text-[12px] text-muted">{l.total} referred · {l.hired} hired</div></div></li>
          ))}</ol> : <div className="text-[14px] text-muted">No referrals yet.</div>}
        </Card>
      </div>
      {act && <Modal title={act.action === 'mark_paid' ? 'Mark bonus as paid' : 'Decline this bonus'} onClose={() => setAct(null)}>
        <div className="stack">
          <p className="mb-0">{act.action === 'mark_paid' ? <>Confirm the bonus for <b>{act.r.referrer_name}</b> (referred {act.r.candidate_name}) has been paid. They'll be notified.</> : <>Tell <b>{act.r.referrer_name}</b> why this bonus is not being paid. They will see your reason.</>}</p>
          {act.action === 'mark_paid' && <Field label="Amount paid (₹)"><input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)} /></Field>}
          <Field label={act.action === 'mark_paid' ? 'Payment note (optional)' : 'Reason'}><input value={note} onChange={e => setNote(e.target.value)} required={act.action === 'decline'} placeholder={act.action === 'mark_paid' ? 'e.g. Paid in November payroll' : 'e.g. Candidate was already in our pipeline'} /></Field>
          <div className="flex justify-end gap-2"><Button onClick={() => setAct(null)}>Cancel</Button><Button variant={act.action === 'mark_paid' ? 'primary' : 'danger'} onClick={doAct} disabled={act.action === 'decline' && !note.trim()}>{act.action === 'mark_paid' ? 'Mark paid' : 'Decline bonus'}</Button></div>
        </div>
      </Modal>}
    </div>
  );
}

function EmployeesTab() {
  const toast = useToast();
  const { data, reload } = useLoad(() => get('/referrals/employees'));
  const [adding, setAdding] = useState(false);
  if (!data) return <Loading />;
  return (
    <Card title="Employee accounts" actions={<Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" />Add employee</Button>}>
      <p className="mt-0 text-[14px] text-muted">Employees can't sign themselves up. HR and admins create their accounts here; each employee gets a one-time email link to set a password. Employee accounts only see the referral portal and don't use paid team seats.</p>
      {data.items.length ? <div className="table-wrap"><table><thead><tr><th>Employee</th><th>Referrals</th><th>Status</th><th className="right">Actions</th></tr></thead><tbody>
        {data.items.map((m: any) => (
          <tr key={m.id}>
            <td><div className="font-semibold">{m.name}</div><div className="text-[12.5px] text-muted">{m.email}{m.designation ? ` · ${m.designation}` : ''}</div></td>
            <td>{m.referrals}</td>
            <td>{m.pending_activation ? <Badge kind="warn">Awaiting activation</Badge> : m.status === 'active' ? <Badge kind="ok">Active</Badge> : <Badge kind="danger">Disabled</Badge>}</td>
            <td className="right"><div className="flex justify-end gap-2">
              {m.pending_activation && <Button size="sm" onClick={async () => { try { await post(`/team/members/${m.id}/resend-activation`); toast('Activation email sent again'); } catch (x: any) { toast(x.message, 'error'); } }}><Mail className="h-3.5 w-3.5" />Resend</Button>}
              <Button size="sm" onClick={async () => { try { await patch(`/team/members/${m.id}`, { status: m.status === 'active' ? 'disabled' : 'active' }); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>{m.status === 'active' ? 'Disable' : 'Enable'}</Button>
            </div></td>
          </tr>
        ))}
      </tbody></table></div> : <Empty title="No employees yet" icon={<Users className="h-6 w-6" />}>Add employees so they can refer candidates and earn bonuses.</Empty>}
      {adding && <AddMember roles={['employee']} title="Add an employee (referral portal)" onClose={() => setAdding(false)} onDone={() => void reload()} />}
    </Card>
  );
}

function ProgramTab() {
  const toast = useToast();
  const { data } = useLoad(() => get('/referrals/program'));
  const [f, setF] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  if (!data) return <Loading />;
  const v = f ?? data;
  return (
    <Card title={<span className="flex items-center gap-2"><Settings2 className="h-5 w-5 text-brand-500" />Programme settings</span>}>
      <form className="stack max-w-2xl" onSubmit={async e => { e.preventDefault(); setErr(null); try { setF(await put('/referrals/program', { enabled: !!v.enabled, defaultBonus: Number(v.defaultBonus) || 0, payoutAfterDays: Number(v.payoutAfterDays) || 0, terms: v.terms || '' })); toast('Programme updated'); } catch (x) { setErr(x); } }}>
        <ErrorBox error={err} />
        <label className="check"><input type="checkbox" checked={!!v.enabled} onChange={e => setF({ ...v, enabled: e.target.checked })} />Referral programme is open</label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Default bonus (₹)" hint="Used when a job has no bonus of its own"><input type="number" min={0} value={v.defaultBonus} onChange={e => setF({ ...v, defaultBonus: e.target.value })} /></Field>
          <Field label="Payout after (days from hire)" hint="e.g. 90 days after joining"><input type="number" min={0} max={730} value={v.payoutAfterDays} onChange={e => setF({ ...v, payoutAfterDays: e.target.value })} /></Field>
        </div>
        <Field label="Programme terms" hint="Shown to employees on the referral page"><textarea value={v.terms} onChange={e => setF({ ...v, terms: e.target.value })} maxLength={3000} /></Field>
        <p className="mb-0 text-[13px] text-muted">Set a different bonus per role in each job's settings (Jobs → Edit → Referral bonus).</p>
        <div><Button variant="primary" type="submit">Save settings</Button></div>
      </form>
    </Card>
  );
}
