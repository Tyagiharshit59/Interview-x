import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, LayoutDashboard, FileText, CalendarDays, Bookmark, UserRound, LogOut, Menu, X, MailCheck, Check } from 'lucide-react';
import { get, post } from '../api';
import { Button, ErrorBox, Field, Loading } from '../ui';

/* ---------------- candidate session (separate from staff auth) ---------------- */
export interface CandMe {
  id: string; email: string; name: string; phone: string | null; headline: string | null; location: string | null; experience_years: number | null;
  skills: string[]; summary: string | null; linkedin: string | null; portfolio: string | null; resume: { name: string; uploaded_at: string } | null;
  emailVerified: boolean; completeness: number;
}
interface Ctx { me: CandMe | null; loading: boolean; setMe: (m: CandMe | null) => void; refresh: () => Promise<void>; logout: () => Promise<void> }
const C = createContext<Ctx>(null as any);
export const useCand = () => useContext(C);
export function CandProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<CandMe | null>(null); const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => { try { setMe(await get('/portal/me')); } catch { setMe(null); } finally { setLoading(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const logout = async () => { await post('/portal/auth/logout'); setMe(null); };
  return <C.Provider value={{ me, loading, setMe, refresh, logout }}>{children}</C.Provider>;
}
export function RequireCand({ children }: { children: ReactNode }) {
  const { me, loading } = useCand(); const loc = useLocation();
  if (loading) return <div className="mx-auto max-w-6xl px-5 py-10"><Loading /></div>;
  if (!me) return <Navigate to="/portal/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

export function CareersLogo({ light }: { light?: boolean }) {
  return (
    <Link to="/portal" className={`group flex items-center gap-2.5 no-underline ${light ? 'text-white hover:text-white' : 'text-ink hover:text-ink'}`}>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-gradient shadow-glow transition group-hover:scale-105"><svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden><path d="M7 18V6l11 6z" /></svg></span>
      <span className="text-[1.1rem] font-extrabold tracking-tight">Intervue<span className="bg-gold-gradient bg-clip-text text-transparent">X</span> <span className="font-semibold text-muted">Careers</span></span>
    </Link>
  );
}

/* ---------------- layout ---------------- */
export function PortalLayout() {
  const { me, logout } = useCand(); const nav = useNavigate(); const [open, setOpen] = useState(false);
  const link = (to: string, label: string, Icon: any) => (
    <NavLink to={to} end={to === '/portal'} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-2 rounded-xl px-3 py-2 text-[14px] font-semibold no-underline transition ${isActive ? 'bg-brand-500/10 text-brand-700 dark:text-brand-200' : 'text-muted hover:bg-raised hover:text-ink'}`}>
      <Icon className="h-4 w-4" />{label}
    </NavLink>
  );
  const links = me ? <>{link('/portal/dashboard', 'Dashboard', LayoutDashboard)}{link('/portal/jobs', 'Find jobs', Search)}{link('/portal/applications', 'Applications', FileText)}{link('/portal/interviews', 'Interviews', CalendarDays)}{link('/portal/saved', 'Saved', Bookmark)}</> : null;
  const initials = (me?.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3 sm:px-8">
          <CareersLogo />
          <nav className="ml-6 hidden items-center gap-1 lg:flex">{links}</nav>
          <div className="flex-1" />
          {me ? (
            <div className="hidden items-center gap-2 lg:flex">
              <Link to="/portal/profile" className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 no-underline hover:bg-raised">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-gold-gradient text-[12px] font-extrabold text-midnight-950">{initials}</span>
                <span className="text-left leading-tight"><span className="block text-[13.5px] font-semibold text-ink">{me.name}</span><span className="block text-[12px] text-muted">Profile {me.completeness}% complete</span></span>
              </Link>
              <button className="btn icon ghost" aria-label="Sign out" title="Sign out" onClick={async () => { await logout(); nav('/portal'); }}><LogOut className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="hidden items-center gap-2 sm:flex"><Link to="/portal/login" className="btn primary">Sign in</Link></div>
          )}
          <button className="btn icon ghost lg:hidden" onClick={() => setOpen(o => !o)} aria-label="Menu">{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
        </div>
        {open && (
          <div className="border-t border-line bg-surface px-5 py-3 lg:hidden">
            <nav className="flex flex-col gap-1">{links}{me ? <>{link('/portal/profile', 'Profile', UserRound)}<button className="btn ghost justify-start" onClick={async () => { await logout(); setOpen(false); nav('/portal'); }}><LogOut className="h-4 w-4" />Sign out</button></>
              : <div className="mt-2 flex gap-2"><Link to="/portal/login" className="btn primary flex-1" onClick={() => setOpen(false)}>Sign in</Link></div>}</nav>
          </div>
        )}
      </header>
      {me && !me.emailVerified && <VerifyStrip />}
      <main className="mx-auto max-w-7xl px-5 pb-20 pt-8 sm:px-8"><Outlet /></main>
      <footer className="border-t border-line/70 py-8 text-center text-[13px] text-muted">IntervueX Careers · Are you hiring? <Link to="/">IntervueX for companies</Link></footer>
    </div>
  );
}

function VerifyStrip() {
  const [msg, setMsg] = useState('');
  return (
    <div className="border-b border-warn/20 bg-warn/10">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-2.5 text-[14px] text-warn sm:px-8">
        <MailCheck className="h-4 w-4" /><span>Verify your email to apply for jobs and see interviews companies have invited you to.</span>
        {msg ? <b className="break-all">{msg}</b> : <button className="btn sm" onClick={async () => { const r = await post('/portal/auth/resend-verification'); setMsg(r.devVerifyUrl ? `Dev link: ${r.devVerifyUrl}` : 'Verification email sent.'); }}>Resend email</button>}
      </div>
    </div>
  );
}

/* ---------------- auth pages ---------------- */
function AuthFrame({ title, subtitle, children, foot }: { title: string; subtitle?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.05fr]">
      <main className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[420px] animate-fade-up">
          <div className="mb-8"><CareersLogo /></div>
          <h1 className="mb-1.5 font-display text-[2rem] font-semibold">{title}</h1>
          {subtitle && <p className="mb-0 text-muted">{subtitle}</p>}
          <div className="mt-7 flex flex-col gap-4">{children}</div>
          {foot && <div className="mt-8 text-center text-[14px] text-muted">{foot}</div>}
        </div>
      </main>
      <aside className="relative hidden overflow-hidden bg-night-gradient p-12 text-white lg:flex lg:flex-col lg:justify-center">
        <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-brand-500/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-gold-400/15 blur-3xl" />
        <div className="relative max-w-lg">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-300">For invited candidates</div>
          <h2 className="mt-4 font-display text-[2.4rem] font-semibold leading-[1.1] text-white">Your next role, and every interview, in one place.</h2>
          <ul className="mt-8 flex list-none flex-col gap-3.5 p-0 text-[15px] text-slate-300">
            {['Complete the profile the hiring team started for you', 'Track every application and read company updates', 'Join interviews you are invited to, right from here', 'Discover more roles matched to your skills'].map(t => (
              <li key={t} className="flex items-start gap-3"><span className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-gold-gradient"><Check className="h-3 w-3 text-midnight-950" strokeWidth={3} /></span>{t}</li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

export function PortalLogin() {
  const { setMe } = useCand(); const nav = useNavigate(); const loc = useLocation() as any;
  const [f, setF] = useState({ email: '', password: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { setMe(await post('/portal/auth/login', f)); nav(loc.state?.from || '/portal/dashboard', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <AuthFrame title="Welcome back" subtitle="Sign in to your careers profile." foot={<>New here? Your profile is created when a company invites you. Check your email for the invitation.<br /><span className="text-[12.5px]">Hiring team member? <Link to="/login">Company sign in</Link></span></>}>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={err} />
        <Field label="Email"><input type="email" autoComplete="username" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
        <Button variant="primary" busy={busy} type="submit" className="!min-h-[48px] w-full">Sign in</Button>
        <Link to="/portal/forgot-password" className="small center">Forgot password?</Link>
      </form>
    </AuthFrame>
  );
}

/** Candidates join only through the invitation HR sends when adding them. */
export function PortalRegister() {
  return (
    <AuthFrame title="Profiles are by invitation" subtitle="IntervueX Careers profiles are created when a hiring company adds you as a candidate." foot={<>Already have a profile? <Link to="/portal/login">Sign in</Link></>}>
      <div className="alert">Look for an email titled “…invites you to complete your profile” from the company you're interviewing with, and open the link in it. If it has expired, ask the recruiter to send a new one.</div>
    </AuthFrame>
  );
}

export function PortalAccept() {
  const [sp] = useSearchParams(); const token = sp.get('token') || ''; const { setMe } = useCand(); const nav = useNavigate();
  const [info, setInfo] = useState<any>(null); const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false); const [f, setF] = useState({ password: '', confirm: '' });
  useEffect(() => { get(`/portal/invite/${token}`).then(setInfo).catch(setErr); }, [token]);
  if (err && !info) return <AuthFrame title="Invitation problem" foot={<Link to="/portal/login">Go to sign in</Link>}><ErrorBox error={err} /></AuthFrame>;
  if (!info) return <AuthFrame title="Your invitation"><p className="muted">Checking your link…</p></AuthFrame>;
  if (info.hasAccount) return <AuthFrame title="You already have a profile" foot={<Link to="/portal/forgot-password">Forgot password?</Link>}><div className="alert ok">{info.company} has been linked to your existing profile.</div><Link className="btn primary" to="/portal/login">Sign in</Link></AuthFrame>;
  const mismatch = f.confirm.length > 0 && f.password !== f.confirm;
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  return (
    <AuthFrame title={`Welcome, ${String(info.name || '').split(' ')[0]}`} subtitle={<><b className="text-ink">{info.company}</b> invited you to complete your candidate profile. Set a password to get started.</>} foot={<>Already have a profile? <Link to="/portal/login">Sign in</Link></>}>
      <form className="stack" onSubmit={async e => { e.preventDefault(); if (mismatch) return; setBusy(true); setErr(null); try { setMe(await post(`/portal/invite/${token}`, { password: f.password })); nav('/portal/profile?welcome=1', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
        {err && !err.details && <ErrorBox error={err} />}
        <Field label="Email"><input value={info.email} disabled /></Field>
        <Field label="Create a password" hint="At least 8 characters, with a letter and a number" error={fe('password')}><input type="password" required autoFocus autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match' : undefined}><input type="password" required autoComplete="new-password" value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} /></Field>
        <Button variant="primary" busy={busy} type="submit" className="!min-h-[48px] w-full" disabled={mismatch}>Create my profile</Button>
      </form>
    </AuthFrame>
  );
}

export function PortalVerify() {
  const [sp] = useSearchParams(); const { refresh } = useCand(); const [state, setState] = useState<'work' | 'ok' | string>('work');
  useEffect(() => { post('/portal/auth/verify', { token: sp.get('token') }).then(() => { setState('ok'); void refresh(); }).catch(e => setState(e.message)); /* eslint-disable-next-line */ }, []);
  return <AuthFrame title="Email verification">{state === 'work' ? <p className="muted">Verifying…</p> : state === 'ok' ? <div className="alert ok">Your email is verified. <Link to="/portal/dashboard">Go to your dashboard</Link></div> : <div className="alert error">{state}</div>}</AuthFrame>;
}

export function PortalForgot() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  return (
    <AuthFrame title="Reset your password" foot={<Link to="/portal/login">Back to sign in</Link>}>
      {done ? <div className="alert ok">If a profile exists for that email, a reset link is on its way.{done.devResetUrl && <><br /><small>Dev link: <a href={done.devResetUrl}>open</a></small></>}</div> : (
        <form className="stack" onSubmit={async e => { e.preventDefault(); try { setDone(await post('/portal/auth/forgot-password', { email })); } catch (x) { setErr(x); } }}>
          <ErrorBox error={err} /><Field label="Email"><input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field><Button variant="primary" type="submit">Send reset link</Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function PortalReset() {
  const [sp] = useSearchParams(); const nav = useNavigate(); const [pw, setPw] = useState(''); const [err, setErr] = useState<unknown>(null);
  return (
    <AuthFrame title="Choose a new password">
      <form className="stack" onSubmit={async e => { e.preventDefault(); try { await post('/portal/auth/reset-password', { token: sp.get('token'), password: pw }); nav('/portal/login'); } catch (x) { setErr(x); } }}>
        <ErrorBox error={err} /><Field label="New password" hint="At least 8 characters, with a letter and a number"><input type="password" required autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></Field><Button variant="primary" type="submit">Update password</Button>
      </form>
    </AuthFrame>
  );
}
