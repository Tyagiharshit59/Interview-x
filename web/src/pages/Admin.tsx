import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, fmtDate, get, money, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, statusBadge, useLoad, useToast, PageHeader } from '../ui';
import { ConsoleOverview, CompaniesTable } from './AdminConsole';

export function Admin() {
  const { me } = useAuth();
  const [tab, setTab] = useState(() => { const q = new URLSearchParams(window.location.search).get('tab'); if (q) return q; try { return sessionStorage.getItem('ivx-admin-tab') || 'overview'; } catch { return 'overview'; } });
  const [healthFilter, setHealthFilter] = useState('');
  const go = (t: string) => { setTab(t); try { sessionStorage.setItem('ivx-admin-tab', t); } catch { /* storage unavailable */ } };
  if (!me?.user.isSuperAdmin) return <div className="alert error">Super admin access required.</div>;
  const tabs = [['overview', 'Overview'], ['companies', 'Companies'], ['plans', 'Plans'], ['coupons', 'Coupons'], ['flags', 'Feature flags'], ['announce', 'Announcements'], ['invoices', 'Invoices'], ['support', 'Support'], ['audit', 'Audit'], ['health', 'System health']];
  return (
    <div className="stack">
      <PageHeader eyebrow="IntervueX internal" title="Platform console" description="Every customer company, its growth, health, revenue and limits, plus plans, coupons, support and platform health." />
      <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => { setHealthFilter(''); go(k); }}>{l}</button>)}</div>
      {tab === 'overview' && <ConsoleOverview onOpenCompanies={h => { setHealthFilter(h || ''); go('companies'); }} />}{tab === 'companies' && <CompaniesTable key={healthFilter} initialHealth={healthFilter} />}{tab === 'health' && <Overview />}{tab === 'plans' && <Plans />}{tab === 'coupons' && <Coupons />}{tab === 'flags' && <Flags />}{tab === 'announce' && <Announce />}{tab === 'invoices' && <Invoices />}{tab === 'support' && <Support />}{tab === 'audit' && <Audit />}
    </div>
  );
}

function Overview() {
  const { data: s } = useLoad(() => get('/admin/stats')); const { data: h } = useLoad(() => get('/admin/health'));
  if (!s || !h) return <Loading />;
  const stat = (v: any, l: string) => <Card className="stat"><div className="v">{v}</div><div className="l">{l}</div></Card>;
  return (
    <div className="stack">
      <div className="grid g4">{stat(s.companies, 'Companies')}{stat(s.users, 'Users')}{stat(s.interviews, 'Interviews')}{stat(money(s.revenuePaise), 'Paid revenue (incl. GST)')}{stat(s.paidSubscriptions, 'Paid subscriptions')}{stat(s.trialing, 'Trials')}{stat(s.activeCompanies, 'Active companies')}{stat(s.openSupport, 'Open support requests')}</div>
      <Card title="Platform health"><table><tbody>{Object.entries(h).map(([k, v]: any) => <tr key={k}><th>{k}</th><td>{typeof v === 'object' ? `${v.mode}${v.ready ? ' (ready)' : ' (not ready)'}` : typeof v === 'boolean' ? (v ? <Badge kind="ok">ok</Badge> : <Badge kind="danger">down</Badge>) : String(v)}</td></tr>)}</tbody></table></Card>
    </div>
  );
}

function Companies() {
  const { data, error, reload } = useLoad(() => get('/admin/companies')); const [open, setOpen] = useState<string | null>(null);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  return <Card><div className="table-wrap"><table><thead><tr><th>Company</th><th>Plan</th><th>Subscription</th><th>Members</th><th>Interviews</th><th>Status</th><th /></tr></thead><tbody>
    {data.items.map((c: any) => <tr key={c.id}><td><b>{c.name}</b><div className="small muted">{fmtDate(c.created_at, { dateStyle: 'medium' })}</div></td><td>{c.plan || '—'}</td><td>{c.sub_status ? statusBadge(c.sub_status) : '—'}</td><td>{c.members}</td><td>{c.interviews}</td><td>{statusBadge(c.status)}</td><td className="right"><Button size="sm" onClick={() => setOpen(c.id)}>Manage</Button></td></tr>)}</tbody></table></div>
    {open && <CompanyModal id={open} onClose={() => { setOpen(null); void reload(); }} />}</Card>;
}

function CompanyModal({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast(); const nav = useNavigate(); const { refresh } = useAuth();
  const { data, reload } = useLoad(() => get(`/admin/companies/${id}`), [id]); const { data: plans } = useLoad(() => get('/admin/plans'));
  const [custom, setCustom] = useState<string | null>(null); const [plan, setPlan] = useState(''); const [ext, setExt] = useState('');
  if (!data) return <Modal title="Company" onClose={onClose}><Loading /></Modal>;
  const c = data.company;
  const apply = async (body: any) => { try { await put(`/admin/companies/${id}/subscription`, body); toast('Updated'); void reload(); } catch (e: any) { toast(e.message, 'error'); } };
  return (
    <Modal title={c.name} onClose={onClose} wide>
      <div className="stack">
        <div className="row">{statusBadge(c.status)}<Button size="sm" variant={c.status === 'active' ? 'danger' : 'primary'} onClick={async () => { await patch(`/admin/companies/${id}/status`, { status: c.status === 'active' ? 'suspended' : 'active' }); void reload(); }}>{c.status === 'active' ? 'Suspend' : 'Reactivate'}</Button>
          <Button size="sm" onClick={async () => { try { await post(`/admin/companies/${id}/support-session`); await refresh(); nav('/dashboard'); toast('Read-only support session started (1 hour, audited)'); } catch (e: any) { toast(e.message, 'error'); } }}>Start support session</Button></div>
        <div className="grid g2">
          <Card title="Subscription" className="flat"><div>Status: {data.subscription ? statusBadge(data.subscription.status) : 'none'} · ends {fmtDate(data.subscription?.current_period_end, { dateStyle: 'medium' })}</div>
            <div className="row" style={{ marginTop: 8 }}><select style={{ width: 160 }} value={plan} onChange={e => setPlan(e.target.value)} aria-label="Plan"><option value="">Change plan…</option>{plans?.items.map((p: any) => <option key={p.code} value={p.code}>{p.name}</option>)}</select><Button size="sm" disabled={!plan} onClick={() => apply({ planCode: plan, status: 'active' })}>Apply</Button></div>
            <div className="row" style={{ marginTop: 8 }}><input style={{ width: 100 }} type="number" placeholder="days" value={ext} onChange={e => setExt(e.target.value)} aria-label="Extend days" /><Button size="sm" disabled={!ext} onClick={() => apply({ extendDays: Number(ext) })}>Extend</Button></div></Card>
          <Card title="Usage" className="flat"><table><tbody>{Object.entries(data.usage).filter(([k]) => k !== 'status').map(([k, v]: any) => <tr key={k}><td>{k.replace('_', ' ')}</td><td>{v.used}{v.limit != null ? ` / ${v.limit === -1 ? '∞' : v.limit}` : ''}</td></tr>)}</tbody></table></Card>
        </div>
        <Card title="Negotiated entitlements (overrides plan)" className="flat"><p className="small muted">JSON, e.g. {'{"members": 50, "interviews_per_month": 1000, "sso": true}'}. Use -1 for unlimited. Also used for add-ons.</p>
          <textarea className="mono" rows={4} value={custom ?? JSON.stringify(data.subscription?.custom_entitlements || {}, null, 2)} onChange={e => setCustom(e.target.value)} aria-label="Custom entitlements" />
          <Button size="sm" onClick={() => { try { void apply({ customEntitlements: JSON.parse(custom ?? '{}') }); } catch { toast('Invalid JSON', 'error'); } }}>Save overrides</Button></Card>
        <Card title="Members" className="flat"><table><tbody>{data.members.map((m: any) => <tr key={m.email}><td>{m.name}</td><td className="small">{m.email}</td><td>{m.role}</td><td>{m.status}</td></tr>)}</tbody></table></Card>
        <Card title="Support requests" className="flat">{data.support.length ? data.support.map((s: any) => <div key={s.id} className="small">{s.subject} · {s.status} {s.support_access_until && new Date(s.support_access_until) > new Date() && <Badge kind="warn">access granted until {fmtDate(s.support_access_until)}</Badge>}</div>) : <span className="muted">None</span>}</Card>
      </div>
    </Modal>
  );
}

function Plans() {
  const toast = useToast(); const { data, reload } = useLoad(() => get('/admin/plans')); const [edit, setEdit] = useState<any>(null);
  if (!data) return <Loading />;
  return <Card title="Subscription plans" actions={<Button size="sm" variant="primary" onClick={() => setEdit({ code: '', name: '', description: '', price_monthly: 0, price_yearly: 0, entitlements: { ...data.knownEntitlements }, overage: {}, is_public: true, is_active: true, sort_order: data.items.length + 1, trial_days: 14 })}>New plan</Button>}>
    <p className="small muted">Prices are whole rupees excluding GST. Entitlements: -1 means unlimited. Nothing here is hard-coded in the app.</p>
    <div className="table-wrap"><table><thead><tr><th>Plan</th><th>Monthly</th><th>Yearly</th><th>Public</th><th>Active</th><th /></tr></thead><tbody>{data.items.map((p: any) => <tr key={p.id}><td><b>{p.name}</b><div className="small muted">{p.code}</div></td><td>₹{p.price_monthly}</td><td>₹{p.price_yearly}</td><td>{p.is_public ? 'yes' : 'no'}</td><td>{p.is_active ? 'yes' : 'no'}</td><td className="right"><Button size="sm" onClick={() => setEdit(p)}>Edit</Button></td></tr>)}</tbody></table></div>
    {edit && <PlanEditor p={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); toast('Plan saved'); }} />}</Card>;
}
function PlanEditor({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ ...p, ent: JSON.stringify(p.entitlements, null, 2), over: JSON.stringify(p.overage || {}, null, 2) }); const [err, setErr] = useState<unknown>(null);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  return <Modal title={p.id ? `Edit ${p.name}` : 'New plan'} onClose={onClose} wide><form className="stack" onSubmit={async e => { e.preventDefault(); setErr(null); try {
    const body = { code: f.code, name: f.name, description: f.description || null, price_monthly: Number(f.price_monthly), price_yearly: Number(f.price_yearly), entitlements: JSON.parse(f.ent), overage: JSON.parse(f.over), is_public: !!f.is_public, is_active: !!f.is_active, sort_order: Number(f.sort_order), trial_days: Number(f.trial_days) };
    p.id ? await put(`/admin/plans/${p.id}`, body) : await post('/admin/plans', body); onSaved(); } catch (x) { setErr(x); } }}>
    <ErrorBox error={err} /><div className="grid g2"><Field label="Code"><input required value={f.code} onChange={e => set('code', e.target.value)} /></Field><Field label="Name"><input required value={f.name} onChange={e => set('name', e.target.value)} /></Field>
      <Field label="Monthly price (₹)"><input type="number" min={0} value={f.price_monthly} onChange={e => set('price_monthly', e.target.value)} /></Field><Field label="Yearly price (₹)"><input type="number" min={0} value={f.price_yearly} onChange={e => set('price_yearly', e.target.value)} /></Field>
      <Field label="Trial days"><input type="number" min={0} value={f.trial_days} onChange={e => set('trial_days', e.target.value)} /></Field><Field label="Sort order"><input type="number" value={f.sort_order} onChange={e => set('sort_order', e.target.value)} /></Field></div>
    <Field label="Description"><input value={f.description || ''} onChange={e => set('description', e.target.value)} /></Field>
    <Field label="Entitlements (JSON)"><textarea className="mono" rows={10} value={f.ent} onChange={e => set('ent', e.target.value)} /></Field>
    <Field label="Overage rates (JSON, informational)"><textarea className="mono" rows={3} value={f.over} onChange={e => set('over', e.target.value)} /></Field>
    <div className="row"><label className="check"><input type="checkbox" checked={!!f.is_public} onChange={e => set('is_public', e.target.checked)} />Public</label><label className="check"><input type="checkbox" checked={!!f.is_active} onChange={e => set('is_active', e.target.checked)} />Active</label></div>
    <div className="row" style={{ justifyContent: 'flex-end' }}><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div></form></Modal>;
}

function Coupons() {
  const { data, reload } = useLoad(() => get('/admin/coupons')); const [f, setF] = useState({ code: '', percent_off: 10, max_redemptions: '' }); const [err, setErr] = useState<unknown>(null);
  if (!data) return <Loading />;
  return <Card title="Coupons"><form className="row" style={{ alignItems: 'flex-end' }} onSubmit={async e => { e.preventDefault(); setErr(null); try { await post('/admin/coupons', { code: f.code, percent_off: Number(f.percent_off), max_redemptions: f.max_redemptions ? Number(f.max_redemptions) : null }); setF({ code: '', percent_off: 10, max_redemptions: '' }); void reload(); } catch (x) { setErr(x); } }}>
    <Field label="Code"><input required value={f.code} onChange={e => setF({ ...f, code: e.target.value })} /></Field><Field label="% off"><input type="number" min={1} max={100} value={f.percent_off} onChange={e => setF({ ...f, percent_off: Number(e.target.value) })} /></Field><Field label="Max uses"><input type="number" value={f.max_redemptions} onChange={e => setF({ ...f, max_redemptions: e.target.value })} /></Field><Button type="submit" variant="primary">Add</Button></form><ErrorBox error={err} />
    <table><tbody>{data.items.map((c: any) => <tr key={c.code}><td><b>{c.code}</b></td><td>{c.percent_off}%</td><td>{c.redeemed}/{c.max_redemptions ?? '∞'}</td><td>{c.is_active ? <Badge kind="ok">active</Badge> : <Badge>off</Badge>}</td><td className="right">{c.is_active && <Button size="sm" onClick={async () => { await del(`/admin/coupons/${c.code}`); void reload(); }}>Deactivate</Button>}</td></tr>)}</tbody></table></Card>;
}
function Flags() {
  const { data, reload } = useLoad(() => get('/admin/flags')); const [k, setK] = useState('');
  if (!data) return <Loading />;
  return <Card title="Feature flags"><table><tbody>{data.items.map((f: any) => <tr key={f.key}><td><b>{f.key}</b><div className="small muted">{f.description}</div></td><td className="right"><label className="check" style={{ justifyContent: 'flex-end' }}><input type="checkbox" checked={!!f.enabled} onChange={async e => { await put(`/admin/flags/${f.key}`, { enabled: e.target.checked }); void reload(); }} />enabled</label></td></tr>)}</tbody></table>
    <form className="row" style={{ marginTop: 10 }} onSubmit={async e => { e.preventDefault(); if (!k) return; await put(`/admin/flags/${k}`, { enabled: false }); setK(''); void reload(); }}><input placeholder="new_flag_key" value={k} onChange={e => setK(e.target.value)} style={{ maxWidth: 240 }} aria-label="New flag key" /><Button type="submit">Add flag</Button></form></Card>;
}
function Announce() {
  const { data, reload } = useLoad(() => get('/admin/announcements')); const [f, setF] = useState({ message: '', level: 'info' });
  if (!data) return <Loading />;
  return <Card title="System announcements"><form className="row" onSubmit={async e => { e.preventDefault(); await post('/admin/announcements', f); setF({ message: '', level: 'info' }); void reload(); }}><input className="grow" required placeholder="Message shown to all companies" value={f.message} onChange={e => setF({ ...f, message: e.target.value })} aria-label="Message" /><select style={{ width: 130 }} value={f.level} onChange={e => setF({ ...f, level: e.target.value })} aria-label="Level"><option>info</option><option>warning</option><option>critical</option></select><Button type="submit" variant="primary">Publish</Button></form>
    <table><tbody>{data.items.map((a: any) => <tr key={a.id}><td>{a.message}</td><td><Badge>{a.level}</Badge></td><td>{a.active ? <Badge kind="ok">live</Badge> : 'ended'}</td><td className="right">{a.active && <Button size="sm" onClick={async () => { await del(`/admin/announcements/${a.id}`); void reload(); }}>End</Button>}</td></tr>)}</tbody></table></Card>;
}
function Invoices() { const { data } = useLoad(() => get('/admin/invoices')); if (!data) return <Loading />; return <Card title="Invoices & payment status"><table><tbody>{data.items.map((i: any) => <tr key={i.id}><td>{i.number}</td><td>{i.company}</td><td>{money(i.total)}</td><td>{statusBadge(i.status)}</td><td className="small">{fmtDate(i.issued_at)}</td></tr>)}</tbody></table></Card>; }
function Support() {
  const { data, reload } = useLoad(() => get('/admin/support')); if (!data) return <Loading />;
  return <Card title="Support requests">{data.items.length === 0 && <div className="muted">None.</div>}{data.items.map((s: any) => <div key={s.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><div className="row between"><b>{s.subject}</b><select style={{ width: 140 }} value={s.status} onChange={async e => { await patch(`/admin/support/${s.id}`, { status: e.target.value }); void reload(); }} aria-label="Status"><option>open</option><option>in_progress</option><option>resolved</option></select></div><div className="small muted">{s.company} · {s.requester} · {fmtDate(s.created_at)}</div><div>{s.body}</div>{s.support_access_until && new Date(s.support_access_until) > new Date() && <Badge kind="warn">Customer granted access until {fmtDate(s.support_access_until)}</Badge>}</div>)}</Card>;
}
function Audit() { const { data } = useLoad(() => get('/admin/audit')); if (!data) return <Loading />; return <Card title="Platform audit log"><div className="table-wrap"><table><tbody>{data.items.map((a: any) => <tr key={a.id}><td className="small">{fmtDate(a.created_at)}</td><td className="small">{a.actor_label || 'system'}</td><td><Badge>{a.action}</Badge></td><td className="small mono">{(a.target || '').slice(0, 36)}</td></tr>)}</tbody></table></div></Card>; }
