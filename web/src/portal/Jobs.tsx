import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Search, MapPin, Briefcase, Bookmark, BookmarkCheck, Building2, ArrowRight, Sparkles, CheckCircle2, Clock, ChevronLeft, ChevronRight, Globe, Target } from 'lucide-react';
import { del, get, post } from '../api';
import { Button, Empty, ErrorBox, Field, Loading, Modal, useLoad, useToast } from '../ui';
import { useCand } from './Shell';

const ago = (iso?: string) => {
  if (!iso) return ''; const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
export const MatchPill = ({ score }: { score: number | null | undefined }) => score == null ? null : (
  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-bold ring-1 ring-inset ${score >= 70 ? 'bg-ok/10 text-ok ring-ok/25' : score >= 40 ? 'bg-gold-400/15 text-gold-600 ring-gold-400/40 dark:text-gold-300' : 'bg-raised text-muted ring-line'}`}>
    <Target className="h-3 w-3" />{score}% match
  </span>
);
const CompanyMark = ({ name }: { name: string }) => (
  <span className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-gradient-to-br from-brand-500/15 to-gold-400/25 text-[16px] font-extrabold text-brand-700 ring-1 ring-brand-500/15 dark:text-brand-200">{(name || '?').slice(0, 1).toUpperCase()}</span>
);

export function JobCard({ job, onSaved }: { job: any; onSaved?: () => void }) {
  const { me } = useCand(); const toast = useToast(); const nav = useNavigate();
  const [saved, setSaved] = useState(!!job.saved);
  const toggle = async (e: any) => {
    e.preventDefault(); e.stopPropagation();
    if (!me) { nav('/portal/login'); return; }
    try { if (saved) await del(`/portal/jobs/${job.id}/save`); else await post(`/portal/jobs/${job.id}/save`); setSaved(!saved); toast(saved ? 'Removed from saved jobs' : 'Saved'); onSaved?.(); } catch (x: any) { toast(x.message, 'error'); }
  };
  return (
    <Link to={`/portal/jobs/${job.id}`} className="group flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 text-ink no-underline shadow-soft transition duration-200 hover:-translate-y-0.5 hover:border-brand-200 hover:text-ink hover:shadow-lift dark:hover:border-brand-800">
      <div className="flex items-start gap-3.5">
        <CompanyMark name={job.company} />
        <div className="min-w-0 flex-1">
          {job.job_code && <div className="mb-0.5 font-mono text-[11.5px] font-semibold tracking-wide text-gold-600 dark:text-gold-300">{job.job_code}</div>}
          <div className="truncate text-[16px] font-bold group-hover:text-brand-600 dark:group-hover:text-brand-300">{job.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[13.5px] text-muted"><Building2 className="h-3.5 w-3.5" />{job.company}</div>
        </div>
        <button onClick={toggle} className="rounded-lg p-1.5 text-muted transition hover:bg-raised hover:text-brand-600" aria-label={saved ? 'Unsave job' : 'Save job'}>{saved ? <BookmarkCheck className="h-5 w-5 text-brand-500" /> : <Bookmark className="h-5 w-5" />}</button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted">
        {job.location && <span className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{job.location}</span>}
        {job.employment_type && <span className="flex items-center gap-1.5 capitalize"><Briefcase className="h-3.5 w-3.5" />{job.employment_type}</span>}
        {(job.exp_min != null || job.exp_max != null) && <span>{job.exp_min ?? 0}{job.exp_max != null ? `–${job.exp_max}` : '+'} yrs</span>}
      </div>
      {job.required_skills?.length > 0 && <div className="chips">{job.required_skills.slice(0, 5).map((s: string) => <span key={s} className={`chip ${job.matchedSkills?.includes(s) ? '' : 'gray'}`}>{s}</span>)}</div>}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line/70 pt-3">
        <span className="text-[12.5px] text-muted">{ago(job.posted_at)}</span>
        <span className="flex items-center gap-2">{job.applied && <span className="badge ok"><CheckCircle2 className="h-3 w-3" />Applied</span>}<MatchPill score={job.match} /></span>
      </div>
    </Link>
  );
}

/* ---------------- careers home ---------------- */
export function PortalHome() {
  const nav = useNavigate(); const { me } = useCand();
  const [q, setQ] = useState(''); const [loc, setLoc] = useState('');
  const { data } = useLoad(() => get('/portal/jobs'));
  const go = (e: FormEvent) => { e.preventDefault(); const p = new URLSearchParams(); if (q) p.set('q', q); if (loc) p.set('location', loc); nav(`/portal/jobs?${p}`); };
  return (
    <div className="flex flex-col gap-14">
      <section className="relative overflow-hidden rounded-[2rem] bg-night-gradient px-6 py-14 text-center text-white shadow-2xl sm:px-12 sm:py-20">
        <div className="pointer-events-none absolute -right-20 -top-24 h-80 w-80 rounded-full bg-brand-500/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -left-10 h-80 w-80 rounded-full bg-gold-400/20 blur-3xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-gold-400/30 bg-gold-400/10 px-3.5 py-1.5 text-[12.5px] font-semibold text-gold-200"><Sparkles className="h-3.5 w-3.5" />{data ? `${data.total} open roles` : 'Open roles'} from companies hiring on IntervueX</span>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-[2.4rem] font-semibold leading-[1.08] text-white sm:text-[3.6rem]">Find work you'll <span className="bg-gold-gradient bg-clip-text italic text-transparent">love</span>.</h1>
          <p className="mx-auto mt-4 max-w-xl text-[16px] text-slate-300">Search open roles, apply with one profile, and track every application and interview in one place.</p>
          <form onSubmit={go} className="mx-auto mt-8 flex max-w-3xl flex-col gap-2 rounded-2xl bg-white/10 p-2 ring-1 ring-white/15 backdrop-blur sm:flex-row">
            <div className="relative flex-1"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Job title, skill or keyword" aria-label="Keywords" className="!min-h-[50px] !border-0 !bg-white !pl-10 !text-midnight-950" /></div>
            <div className="relative sm:w-56"><MapPin className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={loc} onChange={e => setLoc(e.target.value)} placeholder="Location" aria-label="Location" className="!min-h-[50px] !border-0 !bg-white !pl-10 !text-midnight-950" /></div>
            <button className="btn gold !min-h-[50px] !rounded-xl !px-6" type="submit">Search jobs</button>
          </form>
          {!me && <div className="mt-6 text-[14px] text-slate-300"><Link to="/portal/register" className="font-semibold text-gold-200 hover:text-gold-100">Create your profile</Link> to get jobs matched to your skills.</div>}
        </div>
      </section>

      <section>
        <div className="mb-5 flex items-end justify-between gap-3">
          <div><div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-500">Latest openings</div><h2 className="mb-0 mt-1 text-2xl">Fresh roles this week</h2></div>
          <Link to="/portal/jobs" className="btn ghost">Browse all <ArrowRight className="h-4 w-4" /></Link>
        </div>
        {!data ? <Loading /> : data.items.length ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{data.items.slice(0, 6).map((j: any) => <JobCard key={j.id} job={j} />)}</div>
          : <Empty title="No open roles yet" icon={<Briefcase className="h-6 w-6" />}>Companies publish roles here when they start hiring. Check back soon.</Empty>}
      </section>
    </div>
  );
}

/* ---------------- search ---------------- */
export function JobSearch() {
  const [sp, setSp] = useSearchParams(); const { me } = useCand();
  const params = Object.fromEntries(sp.entries());
  const [q, setQ] = useState(params.q || ''); const [loc, setLoc] = useState(params.location || '');
  const { data, error, loading } = useLoad(() => get(`/portal/jobs?${sp.toString()}`), [sp.toString()]);
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n); };
  return (
    <div className="flex flex-col gap-6">
      <div><div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-500">Job search</div><h1 className="mb-0 mt-1">Find your next role</h1></div>
      <form onSubmit={e => { e.preventDefault(); const n = new URLSearchParams(sp); q ? n.set('q', q) : n.delete('q'); loc ? n.set('location', loc) : n.delete('location'); n.delete('page'); setSp(n); }}
        className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-2 shadow-soft sm:flex-row">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Job ID, title, skill or keyword" aria-label="Keywords" className="!border-0 !pl-10 !shadow-none" /></div>
        <div className="relative sm:w-56"><MapPin className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input value={loc} onChange={e => setLoc(e.target.value)} placeholder="Location" aria-label="Location" className="!border-0 !pl-10 !shadow-none" /></div>
        <Button variant="primary" type="submit">Search</Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Employment type" className="!w-auto" value={params.type || ''} onChange={e => setParam('type', e.target.value)}><option value="">Any type</option>{data?.facets.types.map((t: string) => <option key={t} value={t}>{t}</option>)}</select>
        <select aria-label="Location filter" className="!w-auto" value={params.location || ''} onChange={e => { setLoc(e.target.value); setParam('location', e.target.value); }}><option value="">Any location</option>{data?.facets.locations.map((t: string) => <option key={t} value={t}>{t}</option>)}</select>
        {me && <select aria-label="Sort" className="!w-auto" value={params.sort || ''} onChange={e => setParam('sort', e.target.value)}><option value="">Newest first</option><option value="match">Best match for me</option></select>}
        <div className="flex-1" />
        {data && <span className="text-[14px] text-muted">{data.total} role{data.total === 1 ? '' : 's'}</span>}
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data?.items.length ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{data.items.map((j: any) => <JobCard key={j.id} job={j} />)}</div>
          {data.pages > 1 && <div className="flex items-center justify-center gap-3">
            <Button disabled={data.page <= 1} onClick={() => setParam('page', String(data.page - 1))}><ChevronLeft className="h-4 w-4" />Previous</Button>
            <span className="text-[14px] text-muted">Page {data.page} of {data.pages}</span>
            <Button disabled={data.page >= data.pages} onClick={() => setParam('page', String(data.page + 1))}>Next<ChevronRight className="h-4 w-4" /></Button>
          </div>}
        </>
      ) : <Empty title="No roles match your search" icon={<Search className="h-6 w-6" />}>Try fewer keywords or a different location.</Empty>}
    </div>
  );
}

/* ---------------- job detail + apply ---------------- */
export function PortalJobDetail() {
  const { id } = useParams(); const { me } = useCand(); const nav = useNavigate(); const toast = useToast();
  const { data: job, error, reload } = useLoad(() => get(`/portal/jobs/${id}`), [id]);
  const [applying, setApplying] = useState(false);
  if (error) return <Empty title="This job is no longer open" icon={<Briefcase className="h-6 w-6" />}><Link to="/portal/jobs">Browse other roles</Link></Empty>;
  if (!job) return <Loading />;
  const save = async () => { if (!me) return nav('/portal/login', { state: { from: `/portal/jobs/${id}` } }); try { if (job.saved) await del(`/portal/jobs/${id}/save`); else await post(`/portal/jobs/${id}/save`); void reload(); } catch (x: any) { toast(x.message, 'error'); } };
  const section = (title: string, body?: string | null) => body ? <section><h2 className="text-[17px]">{title}</h2><div className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink/90">{body}</div></section> : null;
  return (
    <div className="flex flex-col gap-6">
      <Link to="/portal/jobs" className="flex w-fit items-center gap-1 text-[14px]"><ChevronLeft className="h-4 w-4" />All jobs</Link>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          <div className="rounded-3xl border border-line bg-surface p-6 shadow-soft sm:p-8">
            <div className="flex items-start gap-4"><CompanyMark name={job.company} />
              <div className="min-w-0"><h1 className="mb-1 text-2xl sm:text-3xl">{job.title}</h1><div className="flex items-center gap-1.5 text-muted"><Building2 className="h-4 w-4" />{job.company}{job.company_website && <a href={job.company_website.startsWith('http') ? job.company_website : `https://${job.company_website}`} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-[13px]"><Globe className="h-3.5 w-3.5" />Website</a>}</div></div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {job.location && <span className="badge"><MapPin className="h-3 w-3" />{job.location}</span>}
              {job.employment_type && <span className="badge"><Briefcase className="h-3 w-3" />{job.employment_type}</span>}
              {(job.exp_min != null || job.exp_max != null) && <span className="badge">{job.exp_min ?? 0}{job.exp_max != null ? `–${job.exp_max}` : '+'} years</span>}
              {job.job_code && <span className="badge gold font-mono">Job ID {job.job_code}</span>}
              {job.department && <span className="badge">{job.department}</span>}
              <span className="badge"><Clock className="h-3 w-3" />Posted {ago(job.posted_at).toLowerCase()}</span>
            </div>
          </div>
          <div className="flex flex-col gap-7 rounded-3xl border border-line bg-surface p-6 shadow-soft sm:p-8">
            {section('About the role', job.description)}{section('Responsibilities', job.responsibilities)}{section('Qualifications', job.qualifications)}
            {(job.required_skills.length > 0 || job.preferred_skills.length > 0) && <section><h2 className="text-[17px]">Skills</h2><div className="chips">{job.required_skills.map((s: string) => <span key={s} className="chip">{s}</span>)}{job.preferred_skills.map((s: string) => <span key={s} className="chip gray">{s} · nice to have</span>)}</div></section>}
            {!job.description && !job.responsibilities && !job.qualifications && <p className="muted mb-0">The company hasn't added a detailed description yet.</p>}
          </div>
        </div>
        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-3xl border border-line bg-surface p-6 shadow-soft">
            {job.applied ? <div className="flex flex-col gap-3"><div className="alert ok"><CheckCircle2 className="h-4 w-4" />You applied for this role.</div><Link className="btn primary" to="/portal/applications">Track application</Link></div>
              : <Button variant="primary" className="!min-h-[50px] w-full !rounded-2xl" onClick={() => me ? setApplying(true) : nav('/portal/login', { state: { from: `/portal/jobs/${id}` } })}>Apply now <ArrowRight className="h-4 w-4" /></Button>}
            <Button className="mt-2 w-full" onClick={save}>{job.saved ? <><BookmarkCheck className="h-4 w-4 text-brand-500" />Saved</> : <><Bookmark className="h-4 w-4" />Save for later</>}</Button>
            {!me && <p className="mb-0 mt-3 text-center text-[13px] text-muted"><Link to="/portal/register">Create a profile</Link> to apply and see how well you match.</p>}
          </div>
          {job.matchDetail && (
            <div className="rounded-3xl border border-line bg-surface p-6 shadow-soft">
              <div className="flex items-center justify-between"><h2 className="!mb-0 text-[16px]">How you match</h2><MatchPill score={job.match} /></div>
              <div className="mt-4 flex flex-col gap-3 text-[13.5px]">
                {job.matchDetail.matchedRequired.length > 0 && <div><div className="mb-1.5 font-semibold text-ok">You have</div><div className="chips">{job.matchDetail.matchedRequired.map((s: string) => <span key={s} className="chip">{s}</span>)}</div></div>}
                {job.matchDetail.missingRequired.length > 0 && <div><div className="mb-1.5 font-semibold text-muted">Not in your profile yet</div><div className="chips">{job.matchDetail.missingRequired.map((s: string) => <span key={s} className="chip gray">{s}</span>)}</div></div>}
                <p className="mb-0 text-[12px] text-muted">A simple keyword comparison with your profile. It doesn't judge your ability, and companies make their own decisions.</p>
              </div>
            </div>
          )}
        </aside>
      </div>
      {applying && <ApplyModal job={job} onClose={() => setApplying(false)} onDone={() => { setApplying(false); void reload(); }} />}
    </div>
  );
}

function ApplyModal({ job, onClose, onDone }: { job: any; onClose: () => void; onDone: () => void }) {
  const { me } = useCand(); const toast = useToast();
  const [note, setNote] = useState(''); const [answers, setAnswers] = useState<string[]>(job.screening_questions.map(() => ''));
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  if (!me) return null;
  if (!me.emailVerified) return <Modal title="Verify your email first" onClose={onClose}><p>To protect your identity, companies only receive applications from verified email addresses. Check your inbox for the verification link, or resend it from the banner at the top of the page.</p><div className="flex justify-end"><Button onClick={onClose}>OK</Button></div></Modal>;
  const incomplete = !me.resume && me.skills.length === 0;
  if (done) return (
    <Modal title="Application sent" onClose={onDone}>
      <div className="flex flex-col items-center gap-3 py-2 text-center"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-ok/10 text-ok ring-1 ring-ok/25"><CheckCircle2 className="h-7 w-7" /></span>
        <p className="mb-0">Your application for <b>{job.title}</b> at <b>{job.company}</b> has been sent. You'll see updates and any interview invitations in your dashboard.</p></div>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={onDone}>Keep browsing</Button><Link className="btn primary" to="/portal/applications">Track application</Link></div>
    </Modal>
  );
  return (
    <Modal title={`Apply: ${job.title}`} onClose={onClose} wide>
      <form className="flex flex-col gap-5" onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(null); try { await post(`/portal/jobs/${job.id}/apply`, { cover_note: note || null, answers: job.screening_questions.map((q: string, i: number) => ({ question: q, answer: answers[i] })) }); setDone(true); toast('Application sent'); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
        <div className="flex items-center gap-4 rounded-2xl border border-line bg-raised/50 p-4">
          <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-gold-gradient text-[13px] font-extrabold text-midnight-950">{me.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}</span>
          <div className="min-w-0 flex-1"><div className="font-semibold">{me.name}</div><div className="truncate text-[13px] text-muted">{me.email}{me.headline ? ` · ${me.headline}` : ''}</div>
            <div className="mt-1 text-[12.5px] text-muted">{me.resume ? <>CV: <b className="text-ink">{me.resume.name}</b></> : 'No CV uploaded'} · {me.skills.length} skills</div></div>
          <Link to="/portal/profile" className="btn sm">Edit profile</Link>
        </div>
        {incomplete && <div className="alert warn">Add your skills or upload a CV in your profile before applying, so the company can review you.</div>}
        {job.screening_questions.map((q: string, i: number) => <Field key={i} label={q}><input required value={answers[i]} onChange={e => setAnswers(a => a.map((x, k) => (k === i ? e.target.value : x)))} /></Field>)}
        <Field label="Cover note" hint="Optional: why you're interested in this role"><textarea value={note} onChange={e => setNote(e.target.value)} maxLength={4000} /></Field>
        <p className="mb-0 text-[12.5px] text-muted">By applying, your profile and CV are shared with {job.company} for this role. They become responsible for how they use it.</p>
        <ErrorBox error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" busy={busy} disabled={incomplete}>Submit application</Button></div>
      </form>
    </Modal>
  );
}

/* ---------------- saved ---------------- */
export function SavedJobs() {
  const { data, reload } = useLoad(() => get('/portal/saved'));
  return (
    <div className="flex flex-col gap-6">
      <div><div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-500">Your shortlist</div><h1 className="mb-0 mt-1">Saved jobs</h1></div>
      {!data ? <Loading /> : data.items.length ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{data.items.map((j: any) => <JobCard key={j.id} job={j} onSaved={() => void reload()} />)}</div>
        : <Empty title="No saved jobs yet" icon={<Bookmark className="h-6 w-6" />}>Tap the bookmark on any job to keep it here. <Link to="/portal/jobs">Browse jobs</Link></Empty>}
    </div>
  );
}
