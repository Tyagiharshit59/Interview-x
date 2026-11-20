import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { FileText, CalendarDays, Bookmark, Target, ArrowRight, Video, Clock, Building2, Upload, Download, MessageSquareText, CheckCircle2, CircleDot, XCircle, Sparkles, MapPin, ShieldCheck, Briefcase, Mic, Camera } from 'lucide-react';
import { api, fmtDate, get, post, upload } from '../api';
import { Button, ChipInput, Empty, ErrorBox, Field, Loading, Modal, useLoad, useToast } from '../ui';
import { useCand } from './Shell';
import { JobCard } from './Jobs';
import { getUserMedia } from '../room/useRoom';

const RoomView = lazy(() => import('../room/RoomView').then(m => ({ default: m.RoomView })));
const Head = ({ eyebrow, title, children }: { eyebrow: string; title: React.ReactNode; children?: React.ReactNode }) => (
  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-500">{eyebrow}</div><h1 className="mb-0 mt-1">{title}</h1></div>{children}</div>
);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function Countdown({ iso }: { iso: string }) {
  const [, t] = useState(0); useEffect(() => { const h = setInterval(() => t(x => x + 1), 30000); return () => clearInterval(h); }, []);
  const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return <>now</>;
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return <>{d ? `${d}d ` : ''}{h ? `${h}h ` : ''}{m}m</>;
}

/* ---------------- dashboard ---------------- */
export function CandDashboard() {
  const { me } = useCand();
  const { data } = useLoad(() => get('/portal/overview'));
  const { data: rec } = useLoad(() => get('/portal/recommendations'));
  if (!data || !me) return <Loading />;
  const c = data.counts; const nx = data.nextInterview;
  const stat = (label: string, v: number, Icon: any, to: string, tone: string) => (
    <Link to={to} className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-ink no-underline shadow-soft transition hover:-translate-y-0.5 hover:text-ink hover:shadow-lift">
      <span className={`grid h-11 w-11 place-items-center rounded-xl text-white ${tone}`}><Icon className="h-5 w-5" /></span>
      <div><div className="text-2xl font-extrabold leading-none">{v}</div><div className="mt-1 text-[13px] font-semibold text-muted">{label}</div></div>
    </Link>
  );
  return (
    <div className="flex flex-col gap-7">
      <Head eyebrow="Your dashboard" title={<>Hi, <span className="bg-brand-gradient bg-clip-text text-transparent">{me.name.split(' ')[0]}</span></>}>
        <Link to="/portal/jobs" className="btn primary">Find jobs <ArrowRight className="h-4 w-4" /></Link>
      </Head>

      {me.completeness < 100 && (
        <div className="relative overflow-hidden rounded-2xl bg-night-gradient p-6 text-white shadow-lift">
          <div className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full bg-brand-500/30 blur-3xl" />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-300">Profile strength</div>
              <div className="mt-1 text-lg font-bold">Your profile is {me.completeness}% complete</div>
              <div className="mt-3 h-2 max-w-md overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gold-gradient" style={{ width: `${me.completeness}%` }} /></div>
              <div className="mt-2 text-[13px] text-slate-400">A complete profile with a CV and skills gets better job matches and stronger applications.</div>
            </div>
            <Link to="/portal/profile" className="btn gold">Complete profile</Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stat('Active applications', c.active, FileText, '/portal/applications', 'bg-brand-gradient')}
        {stat('Upcoming interviews', c.interviews, CalendarDays, '/portal/interviews', 'bg-gradient-to-br from-emerald-500 to-teal-500')}
        {stat('Total applications', c.applications, Briefcase, '/portal/applications', 'bg-gradient-to-br from-sky-500 to-indigo-500')}
        {stat('Saved jobs', c.saved, Bookmark, '/portal/saved', 'bg-gold-gradient')}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_1fr]">
        <section className="card">
          <h2 className="text-[17px]">Next interview</h2>
          {nx ? (
            <div className="flex flex-col gap-4 rounded-2xl border border-brand-200/60 bg-brand-500/[0.05] p-5 dark:border-brand-800">
              <div className="flex items-start gap-4">
                <div className="grid w-16 flex-none place-items-center rounded-xl bg-surface py-2 text-center shadow-sm ring-1 ring-line"><div className="text-[11px] font-bold uppercase text-brand-500">{new Date(nx.scheduled_at).toLocaleDateString(undefined, { month: 'short' })}</div><div className="text-2xl font-extrabold leading-tight">{new Date(nx.scheduled_at).getDate()}</div></div>
                <div className="min-w-0"><div className="text-[16px] font-bold">{nx.title}</div><div className="text-[13.5px] text-muted">{nx.company} · {nx.job_title}</div><div className="mt-1 text-[13.5px]">{when(nx.scheduled_at)} · {nx.duration_min} min</div></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[13px] text-muted"><Clock className="mr-1 inline h-3.5 w-3.5" />Starts in <b className="text-ink"><Countdown iso={nx.scheduled_at} /></b></span>
                {nx.canJoin ? <Link to={`/portal/interviews/${nx.id}/join`} className="btn primary"><Video className="h-4 w-4" />Join interview</Link> : <Link to="/portal/interviews" className="btn sm">Details</Link>}</div>
            </div>
          ) : <Empty title="No interviews scheduled" icon={<CalendarDays className="h-6 w-6" />}>{me.emailVerified ? 'When a company invites you to an interview, it shows up here.' : 'Verify your email to see interviews companies have invited you to.'}</Empty>}
        </section>
        <section className="card">
          <h2 className="text-[17px]">Latest updates from companies</h2>
          {data.updates.length ? <div className="flex flex-col gap-3">{data.updates.map((u: any) => (
            <div key={u.id} className="rounded-xl border border-line p-3.5"><div className="mb-1 flex items-center gap-2 text-[12.5px] text-muted"><MessageSquareText className="h-3.5 w-3.5 text-brand-500" />{u.from} · {fmtDate(u.created_at, { dateStyle: 'medium' })}</div><div className="line-clamp-3 text-[14px]">{u.message}</div></div>
          ))}<Link to="/portal/applications" className="text-[14px]">See all applications →</Link></div> : <Empty title="No updates yet" icon={<MessageSquareText className="h-6 w-6" />}>Companies can share status updates and feedback about your applications here.</Empty>}
        </section>
      </div>

      <section>
        <div className="mb-4 flex items-end justify-between gap-3"><div><div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-500"><Sparkles className="mr-1 inline h-3.5 w-3.5" />Recommended for you</div><h2 className="mb-0 mt-1 text-xl">Jobs that match your profile</h2></div><Link to="/portal/jobs?sort=match" className="btn ghost">More <ArrowRight className="h-4 w-4" /></Link></div>
        {!rec ? <Loading /> : rec.items.length ? <><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{rec.items.slice(0, 6).map((j: any) => <JobCard key={j.id} job={j} />)}</div><p className="mt-3 text-[12.5px] text-muted">{rec.reason}</p></>
          : <Empty title="No recommendations yet" icon={<Target className="h-6 w-6" />}>{rec.reason || 'Add skills to your profile to get matched jobs.'} <Link to="/portal/profile">Update profile</Link></Empty>}
      </section>
    </div>
  );
}

/* ---------------- applications ---------------- */
const STEPS = ['Applied', 'Under review', 'Interview', 'Decision'];
function Progress({ status }: { status: any }) {
  if (status.key === 'withdrawn') return <span className="badge"><XCircle className="h-3 w-3" />Withdrawn</span>;
  return (
    <div className="flex items-center gap-1.5" aria-label={`Status: ${status.label}`}>
      {STEPS.map((s, i) => { const done = status.step > i + 1 || (status.step === i + 1); const current = status.step === i + 1; const closed = status.key === 'closed' && i === 3;
        return <div key={s} className="flex items-center gap-1.5">
          <span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${closed ? 'bg-raised text-muted' : done ? (current ? 'bg-brand-gradient text-white shadow-glow' : 'bg-brand-500/15 text-brand-600 dark:text-brand-300') : 'bg-raised text-muted'}`}>{done && !current ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}</span>
          <span className={`hidden text-[12.5px] sm:inline ${current ? 'font-semibold text-ink' : 'text-muted'}`}>{s}</span>
          {i < STEPS.length - 1 && <span className={`h-px w-4 sm:w-8 ${status.step > i + 1 ? 'bg-brand-400' : 'bg-line'}`} />}
        </div>; })}
    </div>
  );
}
export function CandApplications() {
  const toast = useToast();
  const { data, reload } = useLoad(() => get('/portal/applications'));
  const [withdraw, setWithdraw] = useState<any>(null);
  const tone: Record<string, string> = { received: 'info', review: 'info', interview: 'warn', interviewed: 'warn', selected: 'ok', closed: '', withdrawn: '' };
  return (
    <div className="flex flex-col gap-6">
      <Head eyebrow="Track progress" title="My applications" />
      {!data ? <Loading /> : data.needsVerification ? <div className="alert warn">Verify your email to see your applications. Check your inbox or resend the link from the banner above.</div>
        : data.items.length ? data.items.map((a: any) => (
          <article key={a.id} className="card flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><Link to={`/portal/jobs/${a.job_id}`} className="text-[17px] font-bold text-ink hover:text-brand-600">{a.job_title}</Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-muted"><span className="flex items-center gap-1"><Building2 className="h-3.5 w-3.5" />{a.company}</span>{a.location && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{a.location}</span>}<span>Applied {fmtDate(a.applied_at, { dateStyle: 'medium' })}</span></div></div>
              <span className={`badge ${tone[a.status.key] || ''}`}>{a.status.label}</span>
            </div>
            <Progress status={a.status} />
            {a.interviews.length > 0 && <div className="flex flex-col gap-2">{a.interviews.map((i: any) => <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-raised/60 px-3.5 py-2.5 text-[14px]"><span className="flex items-center gap-2"><Video className="h-4 w-4 text-brand-500" /><b>{i.title}</b> · {when(i.scheduled_at)}</span><span className="badge">{i.status.replace('_', ' ')}</span></div>)}</div>}
            {a.updates.length > 0 && <div className="flex flex-col gap-2">{a.updates.map((u: any) => (
              <div key={u.id} className={`rounded-xl border p-3.5 ${u.kind === 'feedback' ? 'border-gold-400/40 bg-gold-400/[0.07]' : 'border-line'}`}>
                <div className="mb-1 flex items-center gap-2 text-[12.5px] text-muted"><MessageSquareText className="h-3.5 w-3.5" /><b className="text-ink">{u.kind === 'feedback' ? 'Feedback' : 'Update'}</b> from {u.from} · {fmtDate(u.created_at, { dateStyle: 'medium' })}</div>
                <div className="whitespace-pre-wrap text-[14px]">{u.message}</div>
              </div>))}</div>}
            {a.canWithdraw && <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => setWithdraw(a)}>Withdraw application</Button></div>}
          </article>
        )) : <Empty title="No applications yet" icon={<FileText className="h-6 w-6" />}>Find a role you like and apply in a couple of clicks. <Link to="/portal/jobs">Browse jobs</Link></Empty>}
      {withdraw && <Modal title="Withdraw this application?" onClose={() => setWithdraw(null)}>
        <p>You're withdrawing from <b>{withdraw.job_title}</b> at {withdraw.company}. The company will see that you withdrew. This can't be undone, but you can apply to other roles any time.</p>
        <div className="flex justify-end gap-2"><Button onClick={() => setWithdraw(null)}>Keep application</Button><Button variant="danger" onClick={async () => { try { await post(`/portal/applications/${withdraw.id}/withdraw`); toast('Application withdrawn'); setWithdraw(null); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>Withdraw</Button></div>
      </Modal>}
    </div>
  );
}

/* ---------------- interviews ---------------- */
export function CandInterviews() {
  const { data } = useLoad(() => get('/portal/interviews'));
  const feat = (f: any) => [f.coding && 'Coding', f.whiteboard && 'Whiteboard', f.recording && 'May be recorded (with your consent)', f.secondaryCamera && 'Optional second camera'].filter(Boolean);
  return (
    <div className="flex flex-col gap-6">
      <Head eyebrow="Invited by companies" title="My interviews" />
      <div className="alert"><ShieldCheck className="h-4 w-4" />Only interviews that a company has invited you to appear here, matched to your verified email address.</div>
      {!data ? <Loading /> : data.needsVerification ? <div className="alert warn">Verify your email to see interviews companies have invited you to.</div> : (
        <>
          <section className="flex flex-col gap-4">
            <h2 className="mb-0 text-lg">Upcoming</h2>
            {data.upcoming.length ? data.upcoming.map((i: any) => (
              <article key={i.id} className="card flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="grid w-20 flex-none place-items-center rounded-2xl bg-brand-gradient py-3 text-center text-white shadow-glow"><div className="text-[11px] font-bold uppercase opacity-80">{new Date(i.scheduled_at).toLocaleDateString(undefined, { month: 'short' })}</div><div className="text-3xl font-extrabold leading-tight">{new Date(i.scheduled_at).getDate()}</div><div className="text-[11px] opacity-80">{new Date(i.scheduled_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div></div>
                <div className="min-w-0 flex-1">
                  <div className="text-[17px] font-bold">{i.title} <span className="text-[13px] font-medium text-muted">· Round {i.round_no}</span></div>
                  <div className="text-[13.5px] text-muted">{i.company} · {i.job_title} · {i.duration_min} min</div>
                  <div className="mt-2 chips">{feat(i.features).map((f: any) => <span key={f} className="chip gray">{f}</span>)}</div>
                  {i.instructions && <details className="mt-2 text-[13.5px]"><summary className="cursor-pointer font-semibold">Instructions from the company</summary><div className="mt-1 whitespace-pre-wrap text-muted">{i.instructions}</div></details>}
                </div>
                <div className="flex flex-col items-stretch gap-2 sm:w-48">
                  {i.canJoin ? <Link to={`/portal/interviews/${i.id}/join`} className="btn primary"><Video className="h-4 w-4" />Join now</Link> : <><Button disabled><Clock className="h-4 w-4" />Opens in <Countdown iso={i.opensAt} /></Button><span className="text-center text-[12px] text-muted">The room opens 30 minutes before</span></>}
                </div>
              </article>
            )) : <Empty title="No upcoming interviews" icon={<CalendarDays className="h-6 w-6" />}>When a company invites you, the interview will appear here with a Join button.</Empty>}
          </section>
          {data.past.length > 0 && <section className="flex flex-col gap-3"><h2 className="mb-0 text-lg">Past</h2>
            <div className="card !p-0"><div className="table-wrap"><table><tbody>{data.past.map((i: any) => <tr key={i.id}><td><b>{i.title}</b><div className="small muted">{i.company} · {i.job_title}</div></td><td>{fmtDate(i.scheduled_at)}</td><td className="right"><span className="badge ok">completed</span></td></tr>)}</tbody></table></div></div></section>}
        </>
      )}
    </div>
  );
}

/** Pre-join check and room for an interview the signed-in candidate was invited to. */
export function CandJoin() {
  const { id } = useParams(); const { me } = useCand();
  const { data: info, error } = useLoad(() => get(`/portal/interviews/${id}`), [id]);
  const [stream, setStream] = useState<MediaStream | null>(null); const [devErr, setDevErr] = useState(''); const [inRoom, setInRoom] = useState(false); const [left, setLeft] = useState(false); const [agree, setAgree] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (vid.current) vid.current.srcObject = stream; }, [stream]);
  useEffect(() => () => { stream?.getTracks().forEach(t => t.stop()); }, [stream]);
  if (error) return <Empty title="Interview unavailable">{(error as any).message} <Link to="/portal/interviews">Back to interviews</Link></Empty>;
  if (!info || !me) return <Loading />;
  if (left) return <Empty title="Thanks for joining" icon={<CheckCircle2 className="h-6 w-6" />}>You've left the interview room. <Link to="/portal/interviews">Back to your interviews</Link></Empty>;
  if (inRoom) return (
    <Suspense fallback={<Loading />}>
      <RoomView kind="candidate" displayName={info.candidateFirstName} title={`${info.company} — ${info.title}`} preStream={stream} notice={info.notice}
        getTicket={() => post(`/portal/interviews/${id}/ticket`)} onExit={() => { stream?.getTracks().forEach(t => t.stop()); setLeft(true); setInRoom(false); }} />
    </Suspense>
  );
  const test = async () => { setDevErr(''); try { const s = await getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }); stream?.getTracks().forEach(t => t.stop()); setStream(s); } catch (e: any) { setDevErr(e.message); } };
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Head eyebrow={`${info.company} · ${info.job_title}`} title={info.title} />
      <div className="alert"><CalendarDays className="h-4 w-4" />{new Date(info.scheduled_at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} · {info.duration_min} minutes</div>
      <section className="card flex flex-col gap-4">
        <h2 className="text-[17px]">1. Check your camera and microphone</h2>
        <video ref={vid} autoPlay muted playsInline className="aspect-video w-full rounded-2xl bg-black object-cover" aria-label="Camera preview" />
        {devErr && <div className="alert error">{devErr}</div>}
        <div className="flex flex-wrap gap-2"><Button onClick={test}><Camera className="h-4 w-4" /><Mic className="h-4 w-4" />{stream ? 'Test again' : 'Test camera & mic'}</Button><span className="self-center text-[13px] text-muted">Nothing is shared with the interviewer during this check.</span></div>
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-[17px]">2. Before you join</h2>
        {info.features.recording && <div className="rounded-xl bg-raised/60 p-3.5 text-[14px]"><b className="flex items-center gap-1.5"><CircleDot className="h-4 w-4 text-danger" />Recording</b><p className="mb-0 mt-1 text-muted">{info.notice.recording}</p></div>}
        {info.features.secondaryCamera && <div className="rounded-xl bg-raised/60 p-3.5 text-[14px]"><b>Optional second camera</b><p className="mb-0 mt-1 text-muted">{info.notice.secondaryCamera}</p></div>}
        <label className="check"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />I'm ready to join and understand I'll be asked separately before anything is recorded.</label>
      </section>
      <Button variant="primary" className="!min-h-[52px] !rounded-2xl" disabled={!agree || !info.canJoin} onClick={() => setInRoom(true)}><Video className="h-5 w-5" />{info.canJoin ? 'Enter waiting room' : 'The room opens 30 minutes before the start'}</Button>
    </div>
  );
}

/* ---------------- profile ---------------- */
export function CandProfile() {
  const { me, setMe } = useCand(); const toast = useToast(); const [sp] = useSearchParams(); const loc = useLocation() as any;
  const [f, setF] = useState<any>(null); const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false); const [up, setUp] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (me && !f) setF({ ...me, experience_years: me.experience_years ?? '' }); }, [me, f]);
  if (!me || !f) return <Loading />;
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const save = async (e: any) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api('PATCH', '/portal/profile', { name: f.name, phone: f.phone || null, headline: f.headline || null, location: f.location || null, experience_years: f.experience_years === '' ? null : Number(f.experience_years), skills: f.skills, summary: f.summary || null, linkedin: f.linkedin || null, portfolio: f.portfolio || null });
      setMe(r); setF({ ...r, experience_years: r.experience_years ?? '' }); toast('Profile saved');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const onFile = async (file: File) => {
    setUp(true);
    try { const r = await upload('/portal/profile/resume', file); setMe(r); setF((cur: any) => ({ ...cur, skills: r.skills, experience_years: cur.experience_years === '' ? (r.experience_years ?? '') : cur.experience_years, phone: cur.phone || r.phone })); toast(r.extractedSkills?.length ? `CV uploaded · found ${r.extractedSkills.length} skills` : 'CV uploaded'); }
    catch (x: any) { toast(x.message, 'error'); } finally { setUp(false); }
  };
  return (
    <div className="flex flex-col gap-6">
      <Head eyebrow="Your profile" title="Profile & CV"><span className="text-[14px] text-muted">{me.completeness}% complete</span></Head>
      {sp.get('welcome') && <div className="alert ok"><Sparkles className="h-4 w-4" />Welcome! Upload your CV to fill in your skills automatically, then verify your email to start applying.{loc.state?.devVerifyUrl && <><br /><small className="break-all">Dev verification link: <a href={loc.state.devVerifyUrl}>{loc.state.devVerifyUrl}</a></small></>}</div>}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <form className="card flex flex-col gap-5" onSubmit={save}>
          {err && !err.details && <ErrorBox error={err} />}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Full name" error={fe('name')}><input required value={f.name} onChange={e => set('name', e.target.value)} /></Field>
            <Field label="Headline" hint="e.g. Senior Frontend Engineer"><input value={f.headline || ''} onChange={e => set('headline', e.target.value)} maxLength={120} /></Field>
            <Field label="Email" hint={me.emailVerified ? 'Verified' : 'Not verified yet'}><input value={me.email} disabled /></Field>
            <Field label="Phone"><input value={f.phone || ''} onChange={e => set('phone', e.target.value)} /></Field>
            <Field label="Location"><input value={f.location || ''} onChange={e => set('location', e.target.value)} placeholder="City, country" /></Field>
            <Field label="Years of experience"><input type="number" min={0} max={60} step="0.5" value={f.experience_years} onChange={e => set('experience_years', e.target.value)} /></Field>
          </div>
          <Field label="Skills" hint="These power your job recommendations. Press Enter after each skill."><ChipInput value={f.skills} onChange={v => set('skills', v)} placeholder="e.g. react, python, sql" /></Field>
          <Field label="About you"><textarea value={f.summary || ''} onChange={e => set('summary', e.target.value)} maxLength={3000} placeholder="A short summary of your experience and what you're looking for" /></Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="LinkedIn"><input value={f.linkedin || ''} onChange={e => set('linkedin', e.target.value)} placeholder="linkedin.com/in/…" /></Field>
            <Field label="Portfolio / GitHub"><input value={f.portfolio || ''} onChange={e => set('portfolio', e.target.value)} /></Field>
          </div>
          <div className="flex justify-end"><Button variant="primary" busy={busy} type="submit">Save profile</Button></div>
        </form>
        <aside className="flex flex-col gap-4">
          <div className="card flex flex-col gap-3">
            <h2 className="!mb-0 text-[16px]">Your CV</h2>
            {me.resume ? <div className="flex items-center gap-3 rounded-xl bg-raised/60 p-3"><FileText className="h-8 w-8 text-brand-500" /><div className="min-w-0"><div className="truncate text-[14px] font-semibold">{me.resume.name}</div><div className="text-[12px] text-muted">Uploaded {fmtDate(me.resume.uploaded_at, { dateStyle: 'medium' })}</div></div></div>
              : <p className="mb-0 text-[14px] text-muted">Upload a PDF, DOCX or TXT. We'll pull out your skills and experience automatically.</p>}
            <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.txt" className="hidden" onChange={e => { const x = e.target.files?.[0]; if (x) void onFile(x); e.target.value = ''; }} />
            <Button variant="primary" busy={up} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />{me.resume ? 'Replace CV' : 'Upload CV'}</Button>
            {me.resume && <a className="btn" href="/api/portal/profile/resume"><Download className="h-4 w-4" />Download</a>}
          </div>
          <div className="card text-[13.5px] text-muted"><b className="text-ink">Your privacy</b><p className="mb-0 mt-1">Your profile is private. A company only sees it when you apply to one of its jobs, or if it already invited you using this email address.</p></div>
        </aside>
      </div>
    </div>
  );
}
