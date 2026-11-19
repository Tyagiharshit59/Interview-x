import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { get, post, fmtDate } from '../api';
import { Button } from '../ui';

export function Layout() {
  const { me, logout, can, refresh } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<{ items: any[]; unread: number }>({ items: [], unread: 0 });
  const [showN, setShowN] = useState(false);
  const [banner, setBanner] = useState<any[]>([]);
  const [sub, setSub] = useState<any>(null);
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

  const item = (to: string, label: string, icon: string) => <NavLink to={to} onClick={() => setOpen(false)}>{<span aria-hidden>{icon}</span>}{label}</NavLink>;
  const trialDays = sub?.status === 'trialing' && sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 864e5)) : null;

  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`} aria-label="Main navigation">
        <Link to="/" className="brand"><span className="logo">▶</span>IntervueX</Link>
        <nav className="nav">
          {isAdminOnly ? item('/admin', 'Platform console', '🛡️') : (
            <>
              {item('/dashboard', 'Dashboard', '📊')}
              <div className="sec">Hiring</div>
              {item('/jobs', 'Jobs', '💼')}
              {item('/candidates', 'Candidates', '👥')}
              {item('/interviews', 'Interviews', '🎥')}
              {item('/questions', 'Question bank', '🧩')}
              {can('analytics.view') && item('/analytics', 'Analytics', '📈')}
              <div className="sec">Company</div>
              {item('/team', 'Team', '🧑‍🤝‍🧑')}
              {can('company.manage') && item('/settings', 'Settings', '⚙️')}
              {can('billing.manage') && item('/billing', 'Billing & usage', '💳')}
              {me?.user.isSuperAdmin && item('/admin', 'Platform console', '🛡️')}
            </>
          )}
        </nav>
        <div style={{ marginTop: 'auto' }} className="small muted">
          {me && me.memberships.length > 1 && (
            <select aria-label="Switch company" value={me.company?.id || ''} onChange={async e => { await post('/auth/switch-company', { companyId: e.target.value }); await refresh(); nav('/dashboard'); }}>
              {me.memberships.map(m => <option key={m.company_id} value={m.company_id}>{m.company_name}</option>)}
            </select>
          )}
          <div style={{ padding: '10px 6px' }}>
            <b style={{ color: 'var(--text)' }}>{me?.user.name}</b><br />{me?.company?.name} · {me?.role?.replace('_', ' ')}
          </div>
          <Button size="sm" onClick={async () => { await logout(); nav('/login'); }}>Sign out</Button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="btn icon menu-btn" onClick={() => setOpen(o => !o)} aria-label="Menu">☰</button>
          <div className="grow" />
          {me?.company && (
            <div style={{ position: 'relative' }}>
              <button className="btn icon" aria-label={`Notifications (${notes.unread} unread)`} onClick={() => { setShowN(s => !s); if (notes.unread) void post('/notifications/read').then(() => setNotes(n => ({ ...n, unread: 0 }))); }}>
                🔔{notes.unread > 0 && <span className="badge danger" style={{ marginLeft: 4 }}>{notes.unread}</span>}
              </button>
              {showN && (
                <div className="card" style={{ position: 'absolute', right: 0, top: 46, width: 340, maxHeight: 420, overflow: 'auto', zIndex: 30 }} role="dialog" aria-label="Notifications">
                  {notes.items.length === 0 && <div className="muted">No notifications yet.</div>}
                  {notes.items.map(n => (
                    <div key={n.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <div><b>{n.link ? <Link to={n.link} onClick={() => setShowN(false)}>{n.title}</Link> : n.title}</b></div>
                      {n.body && <div className="small muted">{n.body}</div>}<div className="small muted">{fmtDate(n.created_at)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {banner.map(a => <div key={a.id} className={`alert ${a.level === 'info' ? '' : a.level === 'warning' ? 'warn' : 'error'}`} style={{ marginBottom: 12 }}>📣 {a.message}</div>)}
        {me && !me.user.emailVerified && !isAdminOnly && <VerifyBanner />}
        {trialDays !== null && <div className="alert warn" style={{ marginBottom: 12 }}>Free trial: {trialDays} day{trialDays === 1 ? '' : 's'} left. <Link to="/billing">Choose a plan</Link></div>}
        {sub && ['expired', 'past_due'].includes(sub.status) && <div className="alert error" style={{ marginBottom: 12 }}>Your subscription is {sub.status.replace('_', ' ')}. Some actions are blocked. <Link to="/billing">Renew now</Link></div>}
        <Outlet />
      </div>
    </div>
  );
}

function VerifyBanner() {
  const [msg, setMsg] = useState('');
  return (
    <div className="alert warn" style={{ marginBottom: 12 }}>
      Please verify your email address. {msg ? <b>{msg}</b> : <button className="btn sm" onClick={async () => { const r = await post('/auth/resend-verification'); setMsg(r.devVerifyUrl ? `Dev link: ${r.devVerifyUrl}` : 'Verification email sent.'); }}>Resend email</button>}
    </div>
  );
}
