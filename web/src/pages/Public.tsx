import { Link } from 'react-router-dom';
import { Video, Code2, Smartphone, CircleDot, Brain, ClipboardList, LineChart, ShieldCheck, Check, ArrowRight, Sparkles, Star } from 'lucide-react';
import { get } from '../api';
import { useLoad, Loading } from '../ui';
import { useAuth } from '../auth';
import { Logo } from './Layout';

function PubNav() {
  const { me } = useAuth();
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-1.5 sm:gap-3">
          <Link to="/portal" className="rounded-lg px-3 py-2 text-[14px] font-semibold text-muted hover:text-ink">Find jobs</Link>
          <Link to="/pricing" className="rounded-lg px-3 py-2 text-[14px] font-semibold text-muted hover:text-ink">Pricing</Link>
          {me ? <Link className="btn primary" to={me.user.isSuperAdmin && !me.company ? '/admin' : '/dashboard'}>Open app <ArrowRight className="h-4 w-4" /></Link> : (
            <>
              <Link to="/login" className="hidden rounded-lg px-3 py-2 text-[14px] font-semibold text-muted hover:text-ink sm:inline-block">Sign in</Link>
              <Link className="btn primary" to="/register">Start free trial</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

const FEATURES = [
  [Video, 'Live interview room', 'Browser-based video, panel interviews, waiting room, chat, permissioned screen sharing and reconnection handling.'],
  [Code2, 'Collaborative coding', 'Real-time shared editor, 15 languages, isolated execution, hidden and public tests, history and playback.'],
  [Smartphone, 'Optional second camera', 'Candidates scan a QR code, read a clear consent notice and share a workspace angle. Never secret, never automatic.'],
  [CircleDot, 'Consent-based recording', 'Visible indicators, separate consent for each feed, retention rules, access logging and timeline bookmarks.'],
  [Brain, 'AI assistance, human decisions', 'Question ideas, summaries and draft feedback clearly labelled as AI. No auto-rejection, no face or voice scoring.'],
  [ClipboardList, 'Applicant tracking', 'JD and CV parsing, pipelines, tags, notes and transparent skill-match decision support.'],
  [LineChart, 'Hiring analytics', 'Funnel, interviewer load, durations and coding statistics with plain-language explanations.'],
  [ShieldCheck, 'Built for privacy', 'Tenant isolation, role-based access, MFA, audit logs, short-lived signed links and deletion workflows.'],
] as const;

function HeroPreview() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl">
      <div className="absolute -inset-x-10 -top-10 bottom-0 -z-10 rounded-[3rem] bg-gradient-to-b from-brand-500/20 via-brand-500/5 to-transparent blur-2xl" />
      <div className="overflow-hidden rounded-3xl border border-white/10 bg-midnight-900 shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-rose-400/80" /><span className="h-3 w-3 rounded-full bg-amber-300/80" /><span className="h-3 w-3 rounded-full bg-emerald-400/80" />
          <span className="ml-3 flex items-center gap-2 text-[12px] font-medium text-slate-400"><span className="rec-dot" /> Senior Backend Engineer · Round 2 · 34:12</span>
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-[1.1fr_1fr]">
          <div className="grid grid-rows-2 gap-3">
            {['Priya (Interviewer)', 'Arjun (Candidate)'].map((n, i) => (
              <div key={n} className={`relative overflow-hidden rounded-2xl ${i ? 'bg-gradient-to-br from-brand-900 to-midnight-800' : 'bg-gradient-to-br from-midnight-700 to-brand-950'} min-h-[120px]`}>
                <div className="absolute inset-0 grid place-items-center"><span className="grid h-14 w-14 place-items-center rounded-full bg-white/10 text-lg font-bold text-white">{n[0]}</span></div>
                <span className="absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-0.5 text-[11px] text-white">{n}</span>
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-midnight-950 p-4 text-left font-mono text-[12.5px] leading-relaxed ring-1 ring-white/10">
            <div className="mb-2 flex gap-3 text-[11px] text-slate-500"><span className="text-white">solution.ts</span><span>tests</span></div>
            <div><span className="text-violet-300">function</span> <span className="text-sky-300">topK</span><span className="text-slate-300">(nums: number[], k: number) {'{'}</span></div>
            <div className="pl-4 text-slate-300"><span className="text-violet-300">const</span> freq = <span className="text-violet-300">new</span> <span className="text-amber-200">Map</span>();</div>
            <div className="pl-4 text-slate-300"><span className="text-violet-300">for</span> (<span className="text-violet-300">const</span> n <span className="text-violet-300">of</span> nums) freq.set(n, …);</div>
            <div className="pl-4 text-slate-500">// bucket sort by frequency</div>
            <div className="text-slate-300">{'}'}</div>
            <div className="mt-4 rounded-lg bg-emerald-400/10 px-3 py-2 text-emerald-300">✓ 8 / 8 tests passed · 41 ms</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  return (
    <div className="min-h-full">
      <PubNav />
      <section className="relative overflow-hidden px-5 pb-10 pt-16 text-center sm:px-8 sm:pt-24">
        <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl" />
        <span className="inline-flex items-center gap-2 rounded-full border border-gold-400/40 bg-gold-400/10 px-3.5 py-1.5 text-[12.5px] font-semibold text-gold-600 dark:text-gold-200">
          <Sparkles className="h-3.5 w-3.5" /> Recruitment · Live interviews · Coding · Analytics
        </span>
        <h1 className="mx-auto mt-6 max-w-4xl font-display text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-[4.2rem]">
          Hire with <span className="bg-brand-gradient bg-clip-text italic text-transparent">clarity</span>,<br className="hidden sm:block" /> interview with <span className="bg-gold-gradient bg-clip-text italic text-transparent">confidence</span>.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted sm:text-lg">
          IntervueX brings your pipeline, live video interviews, collaborative coding and structured evaluation together, with privacy controls your candidates can actually see.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link className="btn primary !min-h-[50px] !rounded-2xl !px-6 !text-[15px]" to="/register">Start 14-day free trial <ArrowRight className="h-4 w-4" /></Link>
          <Link className="btn !min-h-[50px] !rounded-2xl !px-6 !text-[15px]" to="/pricing">See pricing</Link>
        </div>
        <div className="mt-5 text-[13px] text-muted">No card required · Set up in under five minutes · Looking for a job? <Link to="/portal">Visit IntervueX Careers</Link></div>
        <HeroPreview />
      </section>

      <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-500">Everything in one place</div>
          <h2 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">A complete interviewing suite, thoughtfully built</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(([Icon, t, d]) => (
            <div key={t} className="group rounded-2xl border border-line bg-surface p-6 shadow-soft transition duration-300 hover:-translate-y-1 hover:border-brand-200 hover:shadow-lift dark:hover:border-brand-800">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/10 text-brand-600 ring-1 ring-brand-500/20 transition group-hover:bg-brand-gradient group-hover:text-white dark:text-brand-300"><Icon className="h-5 w-5" /></span>
              <h3 className="mt-4 text-[16px]">{t}</h3>
              <p className="mb-0 text-[14px] leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-5 pb-20 sm:px-8">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-night-gradient px-6 py-14 text-center text-white shadow-2xl sm:px-12">
          <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-brand-500/30 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 -left-10 h-72 w-72 rounded-full bg-gold-400/20 blur-3xl" />
          <div className="relative">
            <div className="flex justify-center gap-1 text-gold-300">{[0, 1, 2, 3, 4].map(i => <Star key={i} className="h-4 w-4 fill-current" />)}</div>
            <h2 className="mx-auto mt-4 max-w-2xl font-display text-3xl font-semibold text-white sm:text-4xl">Give every candidate a fair, structured, respectful interview.</h2>
            <p className="mx-auto mt-4 max-w-xl text-slate-300">Evidence-based scorecards, independent feedback and human-only decisions are built into every step.</p>
            <Link className="btn gold mt-8 !min-h-[50px] !rounded-2xl !px-7 !text-[15px]" to="/register">Get started free <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </section>
      <footer className="footer">© IntervueX · Compliance claims require your own legal review.</footer>
    </div>
  );
}

export function PricingPage() {
  const { data, loading } = useLoad(() => get('/public/plans'));
  const label: Record<string, string> = { members: 'team accounts', interviews_per_month: 'interviews / month', code_runs_per_month: 'code runs / month', ai_calls_per_month: 'AI requests / month', recording_retention_days: 'days recording retention' };
  return (
    <div className="min-h-full">
      <PubNav />
      <section className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-500">Pricing</div>
          <h1 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Simple plans that grow with your hiring</h1>
          <p className="mt-4 text-muted">{data?.gstNote} Enterprise customers get negotiated limits, SSO, API access and an SLA. <a href="mailto:sales@example.com">Contact sales</a></p>
        </div>
        {loading ? <div className="mt-12"><Loading /></div> : (
          <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {data.items.map((p: any) => {
              const e = p.entitlements; const unl = (v: number) => (v === -1 ? 'Unlimited' : v); const pop = p.code === 'professional';
              const feats = [
                ...Object.keys(label).filter(k => e[k] !== undefined && e[k] !== 0).map(k => `${unl(e[k])} ${label[k]}`),
                ...(e.coding ? ['Collaborative coding'] : []), ...(e.recording ? ['Consent-based recording'] : []), ...(e.ai ? ['AI assistance'] : []),
                ...(e.secondary_camera ? ['QR secondary camera'] : []), ...(e.analytics ? ['Analytics'] : []), ...(e.custom_evaluation ? ['Custom evaluation forms'] : []),
              ];
              return (
                <div key={p.code} className={`relative flex flex-col rounded-3xl p-7 transition duration-300 hover:-translate-y-1 ${pop ? 'bg-night-gradient text-white shadow-2xl ring-1 ring-brand-500/40' : 'border border-line bg-surface shadow-soft hover:shadow-lift'}`}>
                  {pop && <span className="absolute -top-3 left-7 rounded-full bg-gold-gradient px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-midnight-950 shadow">Most popular</span>}
                  <h2 className={`text-xl ${pop ? 'text-white' : ''}`}>{p.name}</h2>
                  <p className={`mb-0 min-h-[44px] text-[14px] ${pop ? 'text-slate-300' : 'text-muted'}`}>{p.description}</p>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="font-display text-5xl font-semibold tracking-tight">₹{p.price_monthly.toLocaleString('en-IN')}</span>
                    <span className={pop ? 'text-slate-400' : 'text-muted'}>/month</span>
                  </div>
                  <div className={`mt-1 text-[13px] ${pop ? 'text-slate-400' : 'text-muted'}`}>or ₹{p.price_yearly.toLocaleString('en-IN')} billed yearly</div>
                  <ul className="my-7 flex flex-1 list-none flex-col gap-2.5 p-0">
                    {feats.map(f => <li key={f} className="flex items-start gap-2.5 text-[14px]"><Check className={`mt-0.5 h-4 w-4 flex-none ${pop ? 'text-gold-300' : 'text-brand-500'}`} /><span className={pop ? 'text-slate-200' : ''}>{f}</span></li>)}
                  </ul>
                  <Link className={`btn ${pop ? 'gold' : 'primary'} !min-h-[48px] !rounded-2xl`} to="/register">Start free trial</Link>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <footer className="footer">© IntervueX</footer>
    </div>
  );
}
