import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorBox, Field } from '../ui';
import { Check } from 'lucide-react';
import { Logo } from './Layout';

function Shell({ title, children, sub, subtitle }: { title: string; children: ReactNode; sub?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-night-gradient p-12 text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-500/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-gold-400/15 blur-3xl" />
        <div className="relative"><Logo light /></div>
        <div className="relative my-auto max-w-lg">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-300">Structured hiring, beautifully done</div>
          <h2 className="mt-4 font-display text-[2.6rem] font-semibold leading-[1.1] text-white">Every interview, fair, focused and on the record.</h2>
          <ul className="mt-8 flex list-none flex-col gap-3.5 p-0 text-[15px] text-slate-300">
            {['Live video, shared coding and whiteboard in one room', 'Evidence-based scorecards and independent feedback', 'Consent-first recording with clear candidate controls'].map(t => (
              <li key={t} className="flex items-start gap-3"><span className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-gold-gradient"><Check className="h-3 w-3 text-midnight-950" strokeWidth={3} /></span>{t}</li>
            ))}
          </ul>
        </div>
        <div className="relative text-[13px] text-slate-500">© IntervueX</div>
      </aside>
      <main className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[420px] animate-fade-up">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h1 className="mb-1.5 font-display text-[2rem] font-semibold">{title}</h1>
          {subtitle && <p className="mb-0 text-muted">{subtitle}</p>}
          <div className="mt-7 flex flex-col gap-4">{children}</div>
          {sub && <div className="mt-8 text-center text-[14px] text-muted">{sub}</div>}
        </div>
      </main>
    </div>
  );
}
const dest = (me: any) => (me.user.isSuperAdmin && !me.company ? '/admin' : '/dashboard');

export function Login() {
  const { setMe } = useAuth(); const nav = useNavigate(); const loc = useLocation() as any;
  const [f, setF] = useState({ email: '', password: '', totp: '' }); const [mfa, setMfa] = useState(false); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await post('/auth/login', { email: f.email, password: f.password, ...(mfa ? { totp: f.totp } : {}) });
      if (r.mfaRequired) { setMfa(true); return; }
      setMe(r); nav(loc.state?.from || dest(r), { replace: true });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Shell title="Welcome back" subtitle="Sign in to your IntervueX workspace." sub={<>New here? <Link to="/register">Create a company account</Link></>}>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={err} />
        <Field label="Work email"><input type="email" autoComplete="username" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
        {mfa && <Field label="Authentication code" hint="From your authenticator app"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus value={f.totp} onChange={e => setF({ ...f, totp: e.target.value })} /></Field>}
        <Button variant="primary" busy={busy} type="submit" className="!min-h-[48px] w-full">{mfa ? 'Verify and sign in' : 'Sign in'}</Button>
        <Link to="/forgot-password" className="small center">Forgot password?</Link>
      </form>
    </Shell>
  );
}

export function Register() {
  const { setMe } = useAuth(); const nav = useNavigate();
  const [f, setF] = useState({ companyName: '', name: '', email: '', password: '' }); const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await post('/auth/register', f); setMe(r); nav('/dashboard?welcome=1', { replace: true }); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  return (
    <Shell title="Start your free trial" subtitle="14 days of every Professional feature. No card required." sub={<>Already have an account? <Link to="/login">Sign in</Link></>}>
      <form className="stack" onSubmit={submit}>
        {err && !err.details && <ErrorBox error={err} />}
        <Field label="Company name" error={fe('companyName')}><input required value={f.companyName} onChange={e => setF({ ...f, companyName: e.target.value })} /></Field>
        <Field label="Your name" error={fe('name')}><input required autoComplete="name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Work email" error={fe('email')}><input type="email" required autoComplete="username" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password" hint="At least 8 characters, with a letter and a number" error={fe('password')}><input type="password" required autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
        <Button variant="primary" busy={busy} type="submit" className="!min-h-[48px] w-full">Create account</Button>
        <p className="small muted" style={{ margin: 0 }}>No card needed. We'll email you a link to verify your address.</p>
      </form>
    </Shell>
  );
}

export function Forgot() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  return (
    <Shell title="Reset your password" sub={<Link to="/login">Back to sign in</Link>}>
      {done ? <div className="alert ok">If an account exists for that email, a reset link is on its way.{done.devResetUrl && <><br /><small>Dev link: <a href={done.devResetUrl}>open</a></small></>}</div> : (
        <form className="stack" onSubmit={async e => { e.preventDefault(); try { setDone(await post('/auth/forgot-password', { email })); } catch (x) { setErr(x); } }}>
          <ErrorBox error={err} /><Field label="Email"><input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field><Button variant="primary" type="submit">Send reset link</Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const [sp] = useSearchParams(); const nav = useNavigate(); const [pw, setPw] = useState(''); const [err, setErr] = useState<unknown>(null);
  return (
    <Shell title="Choose a new password">
      <form className="stack" onSubmit={async e => { e.preventDefault(); try { await post('/auth/reset-password', { token: sp.get('token'), password: pw }); nav('/login'); } catch (x) { setErr(x); } }}>
        <ErrorBox error={err} /><Field label="New password" hint="At least 8 characters, with a letter and a number"><input type="password" required autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></Field><Button variant="primary" type="submit">Update password</Button>
      </form>
    </Shell>
  );
}

export function VerifyEmail() {
  const [sp] = useSearchParams(); const { refresh } = useAuth(); const [state, setState] = useState<'work' | 'ok' | string>('work');
  useEffect(() => { post('/auth/verify-email', { token: sp.get('token') }).then(() => { setState('ok'); void refresh(); }).catch(e => setState(e.message)); /* eslint-disable-next-line */ }, []);
  return <Shell title="Email verification">{state === 'work' ? <p>Verifying…</p> : state === 'ok' ? <div className="alert ok">Your email is verified. <Link to="/dashboard">Continue</Link></div> : <div className="alert error">{state}</div>}</Shell>;
}

export function AcceptInvite() {
  const [sp] = useSearchParams(); const token = sp.get('token') || ''; const { setMe } = useAuth(); const nav = useNavigate();
  const [info, setInfo] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [f, setF] = useState({ name: '', password: '' });
  useEffect(() => { get(`/auth/invite/${token}`).then(setInfo).catch(setErr); }, [token]);
  if (err && !info) return <Shell title="Invitation"><ErrorBox error={err} /></Shell>;
  if (!info) return <Shell title="Invitation"><p>Loading…</p></Shell>;
  return (
    <Shell title={`Join ${info.company}`}>
      <p className="muted" style={{ margin: 0 }}>You were invited as <b>{info.role.replace('_', ' ')}</b> ({info.email}).</p>
      <form className="stack" onSubmit={async e => { e.preventDefault(); try { const r = await post(`/auth/invite/${token}/accept`, info.hasAccount ? { password: f.password } : f); setMe(r); nav('/dashboard'); } catch (x) { setErr(x); } }}>
        <ErrorBox error={err} />
        {!info.hasAccount && <Field label="Your name"><input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>}
        <Field label={info.hasAccount ? 'Your existing password' : 'Create a password'}><input type="password" required value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
        <Button variant="primary" type="submit">Accept invitation</Button>
      </form>
    </Shell>
  );
}
