import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard, Briefcase, Users, Video, Puzzle, BarChart3, UsersRound, Settings, CreditCard, ShieldCheck,
  Bell, Menu, X, LogOut, Megaphone, Sparkles, ChevronsUpDown, Gift, HeartHandshake, Award,
} from 'lucide-react';
import { useAuth } from '../auth';
import { get, post, fmtDate } from '../api';

export function Logo({ light }: { light?: boolean }) {
  return (
    <Link to="/" className={`group flex items-center gap-2.5 no-underline ${light ? 'text-white hover:text-white' : 'text-ink hover:text-ink'}`}>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-gradient shadow-glow transition group-hover:scale-105">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden><path d="M7 18V6l11 6z" /></svg>
      </span>
      <span className="text-[1.15rem] font-extrabold tracking-tight">Intervue<span className="bg-gold-gradient bg-clip-text text-transparent">X</span></span>
    </Link>
  );
}

function NavItem({ to, icon, children, onClick }: { to: string; icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <NavLink
      to={to} onClick={onClick} end={to === '/referrals'}
      className={({ isActive }) => `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-semibold no-underline transition-all
        ${isActive ? 'bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]' : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'}`}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gold-gradient" />}
          <span className={`grid h-8 w-8 place-items-center rounded-lg transition ${isActive ? 'bg-brand-gradient text-white shadow-glow' : 'bg-white/[0.04] text-slate-400 group-hover:text-white'}`}>{icon}</span>
          {children}
        </>
      )}
    </NavLink>
  );
}
const Section = ({ children }: { children: ReactNode }) => <div className="px-3 pb-1.5 pt-5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-500">{children}</div>;

export function Layout() {
  const { me, logout, can, refresh } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<{ items: any[]; unread: number }>({ items: [], unread: 0 });
  const [showN, setShowN] = useState(false);
  const [banner, setBanner] = useState<any[]>([]);
  const [sub, setSub] = useState<any>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const isAdminOnly = me?.user.isSuperAdmin && !me.company;

  useEffect(() => {
    if (!me?.company) return;
    const load = () => get('/notifications').then(setNotes).catch(() => {});
    load(); const t = setInterval(load, 30000);
    get('/announcements').then(setBanner).catch(() => {});
    if (can('billing.manage')) get('/billing').then(b => setSub(b.subscription)).catch(() => {});
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [me?.company?.id]);
  useEffect(() => {
    if (!showN) return;
    const h = (e: MouseEvent) => { if (!bellRef.current?.contains(e.target as Node)) setShowN(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [showN]);

  const close = () => setOpen(false);
  const ic = 'h-[17px] w-[17px]';
  const trialDays = sub?.status === 'trialing' && sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 864e5)) : null;
  const initials = (me?.user.name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[272px_1fr]">
      {/* ---------- sidebar ---------- */}
      {open && <div className="fixed inset-0 z-30 bg-midnight-950/60 backdrop-blur-sm lg:hidden" onClick={close} />}
      <aside
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col overflow-y-auto bg-night-gradient px-4 pb-4 pt-5 text-slate-200 transition-transform duration-200
          lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}
      >
        <div className="pointer-events-none absolute -top-24 right-[-60px] h-60 w-60 rounded-full bg-brand-500/25 blur-3xl" />
        <div className="relative flex items-center justify-between px-1.5">
          <Logo light />
          <button className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white lg:hidden" onClick={close} aria-label="Close menu"><X className="h-5 w-5" /></button>
        </div>

        {me && me.company && (
          <div className="relative mt-5 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3">
            <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-slate-500">Workspace</div>
            {me.memberships.length > 1 ? (
              <div className="relative mt-1">
                <select aria-label="Switch company" className="!min-h-0 !border-0 !bg-transparent !p-0 !pr-6 !text-[14px] !font-semibold !text-white !shadow-none appearance-none"
                  value={me.company.id} onChange={async e => { await post('/auth/switch-company', { companyId: e.target.value }); await refresh(); nav('/dashboard'); }}>
                  {me.memberships.map(m => <option key={m.company_id} value={m.company_id} className="text-ink">{m.company_name}</option>)}
                </select>
                <ChevronsUpDown className="pointer-events-none absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>
            ) : <div className="mt-1 truncate text-[14px] font-semibold text-white">{me.company.name}</div>}
          </div>
        )}

        <nav className="relative mt-2 flex flex-col gap-0.5">
          {me?.role === 'employee' ? (
            <>
              <Section>Referrals</Section>
              <NavItem to="/referrals" icon={<Gift className={ic} />} onClick={close}>Refer & earn</NavItem>
              <NavItem to="/referrals/mine" icon={<Award className={ic} />} onClick={close}>My referrals</NavItem>
            </>
          ) : isAdminOnly ? <NavItem to="/admin" icon={<ShieldCheck className={ic} />} onClick={close}>Platform console</NavItem> : (
            <>
              <Section>Overview</Section>
              <NavItem to="/dashboard" icon={<LayoutDashboard className={ic} />} onClick={close}>Dashboard</NavItem>
              <Section>Hiring</Section>
              <NavItem to="/jobs" icon={<Briefcase className={ic} />} onClick={close}>Jobs</NavItem>
              <NavItem to="/candidates" icon={<Users className={ic} />} onClick={close}>Candidates</NavItem>
              <NavItem to="/interviews" icon={<Video className={ic} />} onClick={close}>Interviews</NavItem>
              <NavItem to="/questions" icon={<Puzzle className={ic} />} onClick={close}>Question bank</NavItem>
              {can('analytics.view') && <NavItem to="/analytics" icon={<BarChart3 className={ic} />} onClick={close}>Analytics</NavItem>}
              <Section>Company</Section>
              <NavItem to="/team" icon={<UsersRound className={ic} />} onClick={close}>Team</NavItem>
              {can('referrals.manage') && <NavItem to="/referrals/manage" icon={<HeartHandshake className={ic} />} onClick={close}>Referral programme</NavItem>}
              <NavItem to="/referrals" icon={<Gift className={ic} />} onClick={close}>Refer & earn</NavItem>
              {can('company.manage') && <NavItem to="/settings" icon={<Settings className={ic} />} onClick={close}>Settings</NavItem>}
              {can('billing.manage') && <NavItem to="/billing" icon={<CreditCard className={ic} />} onClick={close}>Billing & usage</NavItem>}
              {me?.user.isSuperAdmin && <NavItem to="/admin" icon={<ShieldCheck className={ic} />} onClick={close}>Platform console</NavItem>}
            </>
          )}
        </nav>

        <div className="relative mt-auto pt-6">
          {trialDays !== null && (
            <Link to="/billing" onClick={close} className="mb-3 block rounded-2xl border border-gold-400/25 bg-gradient-to-br from-gold-400/15 to-transparent p-3.5 no-underline hover:border-gold-400/50">
              <div className="flex items-center gap-2 text-[13px] font-bold text-gold-200"><Sparkles className="h-4 w-4" />Free trial</div>
              <div className="mt-1 text-[12.5px] text-slate-300">{trialDays} day{trialDays === 1 ? '' : 's'} left · choose a plan</div>
            </Link>
          )}
          <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-2.5">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-gold-gradient text-[13px] font-extrabold text-midnight-950">{initials}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold text-white">{me?.user.name}</div>
              <div className="truncate text-[12px] capitalize text-slate-400">{me?.role?.replace('_', ' ') || (me?.user.isSuperAdmin ? 'Platform admin' : '')}</div>
            </div>
            <button className="rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white" title="Sign out" aria-label="Sign out" onClick={async () => { await logout(); nav('/login'); }}><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line/70 bg-bg/75 px-4 py-3 backdrop-blur-xl sm:px-8">
          <button className="btn icon ghost lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="lg:hidden"><Logo /></div>
          <div className="flex-1" />
          {me?.company && (
            <div className="relative" ref={bellRef}>
              <button className="btn icon relative" aria-label={`Notifications (${notes.unread} unread)`}
                onClick={() => { setShowN(s => !s); if (notes.unread) void post('/notifications/read').then(() => setNotes(n => ({ ...n, unread: 0 }))); }}>
                <Bell className="h-[18px] w-[18px]" />
                {notes.unread > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[11px] font-bold text-white ring-2 ring-bg">{notes.unread}</span>}
              </button>
              {showN && (
                <div className="absolute right-0 top-12 z-30 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-line bg-surface shadow-lift animate-fade-up" role="dialog" aria-label="Notifications">
                  <div className="border-b border-line px-4 py-3 text-[14px] font-bold">Notifications</div>
                  <div className="max-h-[420px] overflow-y-auto">
                    {notes.items.length === 0 && <div className="px-4 py-10 text-center text-[14px] text-muted">You're all caught up.</div>}
                    {notes.items.map(n => (
                      <div key={n.id} className="border-b border-line/70 px-4 py-3 last:border-0 hover:bg-raised/60">
                        <div className="text-[14px] font-semibold">{n.link ? <Link to={n.link} onClick={() => setShowN(false)}>{n.title}</Link> : n.title}</div>
                        {n.body && <div className="mt-0.5 text-[13px] text-muted">{n.body}</div>}
                        <div className="mt-1 text-[12px] text-muted/80">{fmtDate(n.created_at)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </header>

        <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-6 sm:px-8 sm:pt-8">
          <div className="mb-5 flex flex-col gap-3 empty:hidden">
            {banner.map(a => <div key={a.id} className={`alert ${a.level === 'info' ? '' : a.level === 'warning' ? 'warn' : 'error'}`}><Megaphone className="h-4 w-4" />{a.message}</div>)}
            {me && !me.user.emailVerified && !isAdminOnly && <VerifyBanner />}
            {sub && ['expired', 'past_due'].includes(sub.status) && <div className="alert error">Your subscription is {sub.status.replace('_', ' ')}. Some actions are blocked. <Link to="/billing">Renew now</Link></div>}
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function VerifyBanner() {
  const [msg, setMsg] = useState('');
  return (
    <div className="alert warn">
      Please verify your email address. {msg ? <b className="break-all">{msg}</b> : <button className="btn sm" onClick={async () => { const r = await post('/auth/resend-verification'); setMsg(r.devVerifyUrl ? `Dev link: ${r.devVerifyUrl}` : 'Verification email sent.'); }}>Resend email</button>}
    </div>
  );
}
