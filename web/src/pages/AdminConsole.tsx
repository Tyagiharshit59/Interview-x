import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Building2, Users, Video, IndianRupee, AlertTriangle, Plus, Download, Search, ArrowUpDown, ChevronLeft, Briefcase, UserRound, Activity, Gift, Globe, Tag, StickyNote, ShieldCheck, Clock, CheckCircle2, Copy } from 'lucide-react';
import { fmtDate, get, money, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, CompanyLogo, Empty, ErrorBox, Field, Loading, Meter, Modal, statusBadge, useLoad, useToast } from '../ui';
import { THEME_PRESETS } from '../theme';
import { api } from '../api';
import { BarList, Sparkline, TrendChart, VIZ, fmtINR, fmtNum, monthLabel, weekLabel } from '../charts';

const inr = (n: number) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const ago = (iso?: string | null) => { if (!iso) return 'never'; const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const HEALTH_TONE: Record<string, any> = { healthy: 'ok', trial_ending: 'warn', near_limit: 'warn', inactive: undefined, billing: 'danger', suspended: 'danger', no_plan: undefined };
export const HealthBadge = ({ h }: { h: { key: string; label: string } }) => <Badge kind={HEALTH_TONE[h.key]}>{h.label}</Badge>;

function Kpi({ label, value, hint, icon, tone = 'bg-brand-gradient' }: { label: string; value: ReactNode; hint?: ReactNode; icon: ReactNode; tone?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-soft">
      <div className="flex items-start justify-between gap-3"><div className="text-[13px] font-semibold text-muted">{label}</div><span className={`grid h-9 w-9 place-items-center rounded-xl text-white ${tone}`}>{icon}</span></div>
      <div className="mt-2 text-[1.9rem] font-extrabold leading-none tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1.5 text-[12.5px] text-muted">{hint}</div>}
    </div>
  );
}

/* ======================= Overview ======================= */
export function ConsoleOverview({ onOpenCompanies }: { onOpenCompanies: (health?: string) => void }) {
  const nav = useNavigate();
  const { data, error } = useLoad(() => get('/admin/overview'));
  const [metric, setMetric] = useState<'interviews' | 'applications' | 'new_companies'>('interviews');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const k = data.kpis; const s = data.series; const months = s.interviews.map((p: any) => p.x);
  const ic = 'h-[18px] w-[18px]';
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Companies" value={k.companies} hint={<>{k.active} active · {k.trialing} on trial · {k.suspended} suspended</>} icon={<Building2 className={ic} />} />
        <Kpi label="MRR" value={inr(k.mrr)} hint={<>ARR {inr(k.arr)} · {k.paying} paying</>} icon={<IndianRupee className={ic} />} tone="bg-gold-gradient" />
        <Kpi label="Interviews (30 days)" value={fmtNum(k.interviews_30d)} hint={<>{fmtNum(k.interviews_total)} all time</>} icon={<Video className={ic} />} tone="bg-gradient-to-br from-emerald-500 to-teal-500" />
        <Kpi label="People on the platform" value={fmtNum(k.users + k.candidate_accounts)} hint={<>{k.users} company users · {k.candidate_accounts} candidates</>} icon={<Users className={ic} />} tone="bg-gradient-to-br from-sky-500 to-indigo-500" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[['Revenue collected', inr(k.revenue_total), `${inr(k.revenue_30d)} in last 30 days`], ['Open jobs', fmtNum(k.jobs_open), 'published across all companies'], ['Candidates', fmtNum(k.candidates), `${k.referrals} employee referrals`], ['Open support requests', k.open_support, 'awaiting the IntervueX team']].map(([l, v, h]) => (
          <div key={String(l)} className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-soft"><div className="text-[12.5px] font-semibold text-muted">{l}</div><div className="mt-1 text-xl font-extrabold tabular-nums">{v}</div><div className="text-[12px] text-muted">{h}</div></div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Platform activity · last 12 months" actions={
          <div className="flex rounded-xl border border-line p-0.5 text-[12.5px] font-semibold" role="tablist">
            {([['interviews', 'Interviews'], ['applications', 'Applications'], ['new_companies', 'New companies']] as const).map(([key, l]) => <button key={key} role="tab" aria-selected={metric === key} onClick={() => setMetric(key)} className={`rounded-lg px-2.5 py-1 transition ${metric === key ? 'bg-brand-gradient text-white' : 'text-muted hover:text-ink'}`}>{l}</button>)}
          </div>}>
          <TrendChart title={`${metric} per month`} labels={months} xFormat={monthLabel} series={[{ name: metric === 'new_companies' ? 'New companies' : metric[0].toUpperCase() + metric.slice(1), values: s[metric].map((p: any) => p.y) }]} />
        </Card>
        <Card title="Revenue collected · per month">
          <TrendChart title="Revenue per month" labels={months} xFormat={monthLabel} format={fmtINR} series={[{ name: 'Revenue', values: s.revenue.map((p: any) => p.y), color: VIZ.s1 }]} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card title="Plan mix (active & trial)"><BarList items={data.plan_mix.map((p: any) => ({ label: p.label, value: p.value }))} empty="No subscriptions yet" /></Card>
        <Card title="Account health"><BarList items={data.health.map((h: any) => ({ key: h.key, label: h.label, value: h.value }))} onClick={key => onOpenCompanies(key)} color={VIZ.s1} /><p className="mb-0 mt-3 text-[12px] text-muted">Click a row to see those companies.</p></Card>
        <Card title="Most active · last 30 days"><BarList items={data.top_companies.map((c: any) => ({ key: c.id, label: c.name, value: c.interviews_30d, hint: `${c.candidates} candidates · ${c.plan ?? 'no plan'}` }))} onClick={id => nav(`/admin/companies/${id}`)} color={VIZ.s3} empty="No interviews in the last 30 days" /></Card>
      </div>

      <Card title={<span className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-warn" />Needs attention</span>}>
        {data.attention.length ? <div className="table-wrap"><table><thead><tr><th>Company</th><th>Status</th><th>Plan</th><th>Detail</th><th>Last activity</th></tr></thead><tbody>
          {data.attention.map((a: any) => <tr key={a.id} className="cursor-pointer" onClick={() => nav(`/admin/companies/${a.id}`)}>
            <td className="font-semibold text-brand-600 dark:text-brand-300">{a.name}</td><td><HealthBadge h={a.health} /></td><td>{a.plan ?? '—'}</td>
            <td className="text-[13px] text-muted">{a.health.key === 'trial_ending' ? `Trial ends ${fmtDate(a.trial_ends_at, { dateStyle: 'medium' })}` : a.health.key === 'near_limit' ? `${a.usage.interviews} / ${a.usage.limit} interviews this period` : a.health.key === 'billing' ? `Period ended ${fmtDate(a.current_period_end, { dateStyle: 'medium' })}` : '—'}</td>
            <td className="text-[13px] text-muted">{ago(a.last_activity)}</td></tr>)}
        </tbody></table></div> : <Empty title="Every company looks healthy" icon={<CheckCircle2 className="h-6 w-6" />} />}
      </Card>
    </div>
  );
}

/* ======================= Companies table ======================= */
export function CompaniesTable({ initialHealth = '' }: { initialHealth?: string }) {
  const nav = useNavigate();
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [plan, setPlan] = useState(''); const [health, setHealth] = useState(initialHealth);
  const [sort, setSort] = useState('created'); const [dir, setDir] = useState<'asc' | 'desc'>('desc'); const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(plan ? { plan } : {}), ...(health ? { health } : {}), sort, dir }).toString();
  const { data, error, loading, reload } = useLoad(() => get(`/admin/companies-table?${qs}`), [qs]);
  const th = (key: string, label: string, right = false) => (
    <th className={right ? 'right' : ''}><button type="button" onClick={() => { if (sort === key) setDir(d => (d === 'asc' ? 'desc' : 'asc')); else { setSort(key); setDir(key === 'name' ? 'asc' : 'desc'); } }} className={`inline-flex items-center gap-1 uppercase ${sort === key ? 'text-ink' : ''}`}>{label}<ArrowUpDown className="h-3 w-3" /></button></th>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input className="!pl-10" placeholder="Search name, industry, country, tag" value={q} onChange={e => setQ(e.target.value)} aria-label="Search companies" /></div>
        <select className="!w-auto" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
        <select className="!w-auto" value={plan} onChange={e => setPlan(e.target.value)} aria-label="Plan"><option value="">All plans</option>{data?.plans.map((p: any) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
        <select className="!w-auto" value={health} onChange={e => setHealth(e.target.value)} aria-label="Health"><option value="">Any health</option>{Object.entries({ healthy: 'Healthy', trial_ending: 'Trial ending', near_limit: 'Near limit', billing: 'Billing issue', inactive: 'Inactive 14d+', suspended: 'Suspended', no_plan: 'No plan' }).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <div className="flex-1" />
        <a className="btn" href="/api/admin/companies-export.csv"><Download className="h-4 w-4" />Export CSV</a>
        <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Create company</Button>
      </div>
      <ErrorBox error={error} />
      <Card className="!p-0">
        {loading && !data ? <div className="p-6"><Loading /></div> : data?.items.length ? (
          <div className="table-wrap"><table><thead><tr>{th('name', 'Company')}<th>Plan</th><th>Health</th>{th('team', 'Team', true)}{th('candidates', 'Candidates', true)}{th('interviews', '30d interviews', true)}<th>8-week trend</th>{th('mrr', 'MRR', true)}{th('activity', 'Last active')}</tr></thead><tbody>
            {data.items.map((c: any) => (
              <tr key={c.id} className="cursor-pointer" onClick={() => nav(`/admin/companies/${c.id}`)}>
                <td><div className="flex items-center gap-3"><CompanyLogo name={c.name} src={c.logo} size={34} /><div className="min-w-0"><div className="font-semibold text-brand-600 dark:text-brand-300">{c.name}</div><div className="text-[12px] text-muted">{[c.industry, c.country].filter(Boolean).join(' · ') || c.slug}{c.tags?.length ? ' · ' : ''}{c.tags?.map((t: string) => <span key={t} className="ml-1 rounded bg-gold-400/15 px-1.5 text-[11px] font-semibold text-gold-600 dark:text-gold-300">{t}</span>)}</div></div></div></td>
                <td><div className="text-[13.5px]">{c.plan ?? '—'}</div><div className="text-[12px] text-muted">{c.sub_status ?? ''}</div></td>
                <td><HealthBadge h={c.health} /></td>
                <td className="right tabular-nums">{c.team}{c.employees ? <div className="text-[11.5px] text-muted">+{c.employees} emp.</div> : null}</td>
                <td className="right tabular-nums">{c.candidates}</td>
                <td className="right tabular-nums">{c.interviews_30d}{c.usage.limit > 0 && <div className="text-[11.5px] text-muted">{c.usage.interviews}/{c.usage.limit} period</div>}</td>
                <td><Sparkline values={c.trend} labels={data.weeks} /></td>
                <td className="right tabular-nums">{c.mrr ? inr(c.mrr) : '—'}</td>
                <td className="whitespace-nowrap text-[13px] text-muted">{ago(c.last_activity)}</td>
              </tr>
            ))}
          </tbody></table></div>
        ) : <Empty title="No companies match" icon={<Building2 className="h-6 w-6" />}>Try clearing the filters.</Empty>}
      </Card>
      {creating && <CreateCompany onClose={() => setCreating(false)} onDone={id => { setCreating(false); void reload(); nav(`/admin/companies/${id}`); }} />}
    </div>
  );
}

function CreateCompany({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const { data: plans } = useLoad(() => get('/admin/plans'));
  const [f, setF] = useState({ name: '', industry: '', website: '', country: 'India', owner_name: '', owner_email: '', owner_phone: '', plan_code: '', trial_days: 14, jobCodePrefix: '' });
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState<any>(null);
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await post('/admin/companies', { ...f, plan_code: f.plan_code || plans?.items[0]?.code, trial_days: Number(f.trial_days), jobCodePrefix: f.jobCodePrefix || undefined, industry: f.industry || null, website: f.website || null, country: f.country || null, owner_phone: f.owner_phone || null }); setDone(r); toast('Company created'); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (done) return (
    <Modal title="Company created" onClose={() => onDone(done.id)}>
      <div className="flex flex-col items-center gap-3 py-2 text-center"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-ok/10 text-ok ring-1 ring-ok/25"><CheckCircle2 className="h-7 w-7" /></span>
        <p className="mb-0">{done.newOwnerAccount ? <>We emailed <b>{f.owner_email}</b> a single-use link to set their password and activate the owner account.</> : <><b>{f.owner_email}</b> already had an account and is now the owner. They can sign in right away.</>}</p>
        {done.devActivateUrl && <div className="w-full rounded-xl border border-line bg-raised/60 p-3 text-left text-[12.5px]"><div className="mb-1 font-semibold text-muted">Development only: activation link</div><div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate">{done.devActivateUrl}</code><Button size="sm" onClick={() => void navigator.clipboard?.writeText(done.devActivateUrl)}><Copy className="h-3.5 w-3.5" />Copy</Button></div></div>}
      </div>
      <div className="mt-5 flex justify-end"><Button variant="primary" onClick={() => onDone(done.id)}>Open company</Button></div>
    </Modal>
  );
  return (
    <Modal title="Create a company" onClose={onClose} wide>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        {err && !err.details && <ErrorBox error={err} />}
        <div><div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gold-500">Company</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Company name" error={fe('name')}><input required value={f.name} onChange={e => set('name', e.target.value)} /></Field>
            <Field label="Industry"><input value={f.industry} onChange={e => set('industry', e.target.value)} /></Field>
            <Field label="Website"><input value={f.website} onChange={e => set('website', e.target.value)} /></Field>
            <Field label="Country"><input value={f.country} onChange={e => set('country', e.target.value)} /></Field>
            <Field label="Job ID prefix" hint="Optional; defaults from the company name" error={fe('jobCodePrefix')}><input className="font-mono uppercase" maxLength={8} value={f.jobCodePrefix} onChange={e => set('jobCodePrefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></Field>
          </div></div>
        <div><div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gold-500">Owner (company admin)</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Full name" error={fe('owner_name')}><input required value={f.owner_name} onChange={e => set('owner_name', e.target.value)} /></Field>
            <Field label="Work email" error={fe('owner_email')}><input type="email" required value={f.owner_email} onChange={e => set('owner_email', e.target.value)} /></Field>
            <Field label="Phone"><input value={f.owner_phone} onChange={e => set('owner_phone', e.target.value)} /></Field>
          </div></div>
        <div><div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-gold-500">Subscription</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Plan"><select value={f.plan_code || plans?.items[0]?.code || ''} onChange={e => set('plan_code', e.target.value)}>{plans?.items.filter((p: any) => p.is_active).map((p: any) => <option key={p.code} value={p.code}>{p.name} · ₹{p.price_monthly}/mo</option>)}</select></Field>
            <Field label="Free trial (days)" hint="0 = start as an active paid subscription"><input type="number" min={0} max={365} value={f.trial_days} onChange={e => set('trial_days', e.target.value)} /></Field>
          </div></div>
        <p className="mb-0 text-[12.5px] text-muted">The owner receives a single-use activation link and chooses their own password. No password is set or emailed by IntervueX.</p>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" busy={busy}><Plus className="h-4 w-4" />Create company</Button></div>
      </form>
    </Modal>
  );
}

/* ======================= One company ======================= */
export function CompanyPage() {
  const { id } = useParams(); const toast = useToast(); const nav = useNavigate(); const { refresh } = useAuth();
  const { data, error, reload } = useLoad(() => get(`/admin/companies/${id}/insights`), [id]);
  const [tab, setTab] = useState<'overview' | 'team' | 'subscription' | 'billing' | 'activity' | 'profile'>('overview');
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const c = data.company; const s = data.subscription; const k = data.counts; const se = data.series;
  const ic = 'h-[18px] w-[18px]';
  return (
    <div className="flex flex-col gap-6">
      <Link to="/admin" className="flex w-fit items-center gap-1 text-[14px]"><ChevronLeft className="h-4 w-4" />Platform console</Link>
      <div className="relative overflow-hidden rounded-3xl bg-night-gradient p-6 text-white shadow-lift sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-brand-500/30 blur-3xl" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <CompanyLogo name={c.name} src={c.logoUrl} size={60} className="!ring-white/20" />
            <div><h1 className="mb-1 text-white">{c.name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-300"><HealthBadge h={data.health} />{statusBadge(c.status)}<span>{s?.plan_name ?? 'No plan'}{s ? ` · ${s.status}` : ''}</span><span>· since {fmtDate(c.created_at, { dateStyle: 'medium' })}</span>{c.website && <a className="inline-flex items-center gap-1 text-gold-200" href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer"><Globe className="h-3.5 w-3.5" />website</a>}</div>
              {c.admin_tags?.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{c.admin_tags.map((t: string) => <span key={t} className="rounded-md bg-white/10 px-2 py-0.5 text-[12px] font-semibold text-gold-200">{t}</span>)}</div>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="!border-white/15 !bg-white/10 !text-white hover:!bg-white/20" onClick={async () => { try { await post(`/admin/companies/${id}/support-session`); await refresh(); nav('/dashboard'); toast('Read-only support session started (1 hour, audited)'); } catch (e: any) { toast(e.message, 'error'); } }}><ShieldCheck className="h-4 w-4" />Support session</Button>
            <Button variant={c.status === 'active' ? 'danger' : 'primary'} onClick={async () => { if (!window.confirm(c.status === 'active' ? `Suspend ${c.name}? Their users lose access until reactivated.` : `Reactivate ${c.name}?`)) return; await patch(`/admin/companies/${id}/status`, { status: c.status === 'active' ? 'suspended' : 'active' }); toast(c.status === 'active' ? 'Company suspended' : 'Company reactivated'); void reload(); }}>{c.status === 'active' ? 'Suspend' : 'Reactivate'}</Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Kpi label="MRR" value={data.mrr ? inr(data.mrr) : '—'} icon={<IndianRupee className={ic} />} tone="bg-gold-gradient" />
        <Kpi label="Team" value={k.team} hint={k.employees ? `+${k.employees} employees` : undefined} icon={<UserRound className={ic} />} />
        <Kpi label="Open jobs" value={k.jobs_open} hint={`${k.jobs_total} total`} icon={<Briefcase className={ic} />} tone="bg-gradient-to-br from-sky-500 to-indigo-500" />
        <Kpi label="Candidates" value={k.candidates} hint={`${k.portal_joined} on portal`} icon={<Users className={ic} />} tone="bg-gradient-to-br from-fuchsia-500 to-violet-500" />
        <Kpi label="Interviews" value={k.interviews} hint={`${k.interviews_completed} completed`} icon={<Video className={ic} />} tone="bg-gradient-to-br from-emerald-500 to-teal-500" />
        <Kpi label="Referrals" value={k.referrals} hint={`Last active ${ago(data.last_activity)}`} icon={<Gift className={ic} />} tone="bg-gradient-to-br from-amber-500 to-orange-500" />
      </div>

      <div className="tabs" role="tablist">{([['overview', 'Overview'], ['team', `Team (${data.members.length})`], ['subscription', 'Subscription & limits'], ['billing', 'Billing'], ['activity', 'Activity'], ['profile', 'Profile & notes']] as const).map(([key, l]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{l}</button>)}</div>

      {tab === 'overview' && (
        <div className="flex flex-col gap-5">
          <Card title="Hiring activity · last 12 weeks"><TrendChart title="Weekly activity" labels={se.weeks} xFormat={weekLabel} series={[{ name: 'Applications', values: se.applications.map((p: any) => p.y) }, { name: 'Interviews', values: se.interviews.map((p: any) => p.y) }, { name: 'New candidates', values: se.candidates.map((p: any) => p.y) }]} /></Card>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card title="Hiring funnel (applications by stage)"><BarList items={data.breakdowns.funnel.map((x: any) => ({ label: x.label, value: x.value }))} empty="No applications yet" /></Card>
            <Card title="Usage this billing period">
              <div className="flex flex-col gap-4">{Object.entries(data.usage).filter(([key]) => !['status'].includes(key)).map(([key, v]: any) => <div key={key}><div className="mb-1.5 flex justify-between text-[13.5px]"><span className="font-semibold capitalize">{key.replace(/_/g, ' ')}</span><span className="text-muted">{v.limit === -1 ? 'unlimited' : v.limit == null ? 'not limited' : ''}</span></div><Meter used={v.used} limit={v.limit} /></div>)}</div>
            </Card>
            <Card title="Feature usage · last 12 weeks"><TrendChart title="Code runs and AI calls" height={180} labels={se.weeks} xFormat={weekLabel} series={[{ name: 'Code runs', values: se.code_runs.map((p: any) => p.y) }, { name: 'AI calls', values: se.ai_calls.map((p: any) => p.y) }]} /></Card>
            <div className="grid grid-cols-1 gap-5">
              <Card title="Candidate sources"><BarList items={data.breakdowns.sources.map((x: any) => ({ label: x.label, value: x.value }))} color={VIZ.s1} empty="No candidates yet" /></Card>
              <Card title="Interviews by status"><BarList items={data.breakdowns.interview_status.map((x: any) => ({ label: x.label.replace('_', ' '), value: x.value }))} color={VIZ.s3} empty="No interviews yet" /></Card>
            </div>
          </div>
        </div>
      )}

      {tab === 'team' && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px]">
          <Card title="Members">
            <div className="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Added</th></tr></thead><tbody>
              {data.members.map((m: any) => <tr key={m.id}><td><div className="font-semibold">{m.name}</div><div className="text-[12.5px] text-muted">{m.email}</div></td><td><Badge kind="primary">{m.role.replace('_', ' ')}</Badge></td><td>{m.pending_activation ? <Badge kind="warn">Awaiting activation</Badge> : statusBadge(m.status)}</td><td className="text-[13px] text-muted">{fmtDate(m.created_at, { dateStyle: 'medium' })}</td></tr>)}
            </tbody></table></div>
          </Card>
          <Card title="Roles"><BarList items={data.breakdowns.roles.map((x: any) => ({ label: x.label.replace('_', ' '), value: x.value }))} /></Card>
        </div>
      )}

      {tab === 'subscription' && <SubscriptionPanel id={id!} data={data} onSaved={() => void reload()} />}

      {tab === 'billing' && (
        <Card title={`Invoices · ${inr(k.revenue_paid)} collected`}>
          {data.invoices.length ? <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Description</th><th>Issued</th><th className="right">Total</th><th>Status</th></tr></thead><tbody>
            {data.invoices.map((i: any) => <tr key={i.id}><td className="font-mono text-[13px]">{i.number}</td><td>{i.description}</td><td className="text-[13px] text-muted">{fmtDate(i.issued_at, { dateStyle: 'medium' })}</td><td className="right tabular-nums">{money(i.total)}</td><td>{statusBadge(i.status)}</td></tr>)}
          </tbody></table></div> : <Empty title="No invoices yet" icon={<IndianRupee className="h-6 w-6" />} />}
        </Card>
      )}

      {tab === 'activity' && (
        <Card title={<span className="flex items-center gap-2"><Activity className="h-5 w-5 text-brand-500" />Recent activity</span>}>
          {data.audit.length ? <ol className="m-0 flex list-none flex-col p-0">{data.audit.map((a: any) => (
            <li key={a.id} className="flex items-start gap-3 border-b border-line/70 py-2.5 last:border-0">
              <span className="mt-1.5 h-2 w-2 flex-none rounded-full bg-brand-400" />
              <div className="min-w-0 flex-1"><div className="text-[14px]"><b>{a.action.replace(/[._]/g, ' ')}</b> <span className="text-muted">by {a.actor}</span></div><div className="text-[12px] text-muted">{fmtDate(a.created_at)}</div></div>
            </li>))}</ol> : <Empty title="No activity recorded yet" icon={<Clock className="h-6 w-6" />} />}
        </Card>
      )}

      {tab === 'profile' && <ProfilePanel id={id!} c={c} onSaved={() => void reload()} />}
    </div>
  );
}

function SubscriptionPanel({ id, data, onSaved }: { id: string; data: any; onSaved: () => void }) {
  const toast = useToast(); const s = data.subscription;
  const { data: plans } = useLoad(() => get('/admin/plans'));
  const [plan, setPlan] = useState(''); const [ext, setExt] = useState('30');
  const [com, setCom] = useState({ custom_price_monthly: s?.custom_price_monthly ?? '', custom_price_yearly: s?.custom_price_yearly ?? '', discount_percent: s?.discount_percent ?? 0, billing_cycle: s?.billing_cycle ?? 'monthly' });
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(s?.custom_entitlements || {}).map(([k, v]) => [k, String(v)])));
  const apply = async (body: any, msg = 'Subscription updated') => { try { await put(`/admin/companies/${id}/subscription`, body); toast(msg); onSaved(); } catch (e: any) { toast(e.message, 'error'); } };
  const numericKeys = Object.keys(data.entitlements).filter(k => !k.startsWith('_') && typeof data.entitlements[k] === 'number');
  const boolKeys = Object.keys(data.entitlements).filter(k => !k.startsWith('_') && typeof data.entitlements[k] === 'boolean');
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card title="Plan & period">
        <div className="flex flex-col gap-4 text-[14px]">
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-raised/60 p-4">
            <div><div className="text-[12px] text-muted">Plan</div><b>{s?.plan_name ?? 'None'}</b></div>
            <div><div className="text-[12px] text-muted">Status</div>{s ? statusBadge(s.status) : '—'}</div>
            <div><div className="text-[12px] text-muted">{s?.status === 'trialing' ? 'Trial ends' : 'Period ends'}</div><b>{fmtDate(s?.trial_ends_at || s?.current_period_end, { dateStyle: 'medium' })}</b></div>
            <div><div className="text-[12px] text-muted">MRR</div><b>{data.mrr ? inr(data.mrr) : '—'}</b></div>
          </div>
          <div className="flex flex-wrap items-end gap-2"><Field label="Change plan"><select className="!w-52" value={plan} onChange={e => setPlan(e.target.value)}><option value="">Choose…</option>{plans?.items.map((p: any) => <option key={p.code} value={p.code}>{p.name} · ₹{p.price_monthly}/mo</option>)}</select></Field><Button disabled={!plan} onClick={() => apply({ planCode: plan }, 'Plan changed')}>Apply</Button></div>
          <div className="flex flex-wrap items-end gap-2"><Field label="Extend by (days)"><input className="!w-32" type="number" min={1} value={ext} onChange={e => setExt(e.target.value)} /></Field><Button disabled={!Number(ext)} onClick={() => apply({ extendDays: Number(ext) }, `Extended by ${ext} days`)}>Extend</Button></div>
          <div className="flex flex-wrap gap-2">
            {s?.status !== 'active' && <Button variant="primary" onClick={() => apply({ status: 'active' }, 'Marked active (paid)')}>Mark as active (paid)</Button>}
            {s?.status === 'active' && <Button onClick={() => apply({ status: 'past_due' }, 'Marked past due')}>Mark past due</Button>}
            {s && s.status !== 'cancelled' && <Button variant="danger" onClick={() => { if (window.confirm('Cancel this subscription?')) void apply({ status: 'cancelled' }, 'Subscription cancelled'); }}>Cancel subscription</Button>}
          </div>
        </div>
      </Card>
      <Card title="Commercial terms">
        <form className="flex flex-col gap-4" onSubmit={async e => { e.preventDefault(); try { await put(`/admin/companies/${id}/commercials`, { custom_price_monthly: com.custom_price_monthly === '' ? null : Number(com.custom_price_monthly), custom_price_yearly: com.custom_price_yearly === '' ? null : Number(com.custom_price_yearly), discount_percent: Number(com.discount_percent) || 0, billing_cycle: com.billing_cycle }); toast('Commercial terms saved'); onSaved(); } catch (x: any) { toast(x.message, 'error'); } }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Negotiated monthly (₹)" hint={`Plan list price ₹${s?.plan_price_monthly ?? '—'}`}><input type="number" min={0} value={com.custom_price_monthly} onChange={e => setCom({ ...com, custom_price_monthly: e.target.value })} /></Field>
            <Field label="Negotiated yearly (₹)" hint={`Plan list price ₹${s?.plan_price_yearly ?? '—'}`}><input type="number" min={0} value={com.custom_price_yearly} onChange={e => setCom({ ...com, custom_price_yearly: e.target.value })} /></Field>
            <Field label="Discount (%)"><input type="number" min={0} max={100} value={com.discount_percent} onChange={e => setCom({ ...com, discount_percent: e.target.value })} /></Field>
            <Field label="Billing cycle"><select value={com.billing_cycle} onChange={e => setCom({ ...com, billing_cycle: e.target.value })}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field>
          </div>
          <div><Button variant="primary" type="submit" disabled={!s}>Save terms</Button>{!s && <span className="ml-2 text-[12.5px] text-muted">Assign a plan first.</span>}</div>
        </form>
      </Card>
      <Card title="Limits & features for this company" className="lg:col-span-2">
        <p className="mt-0 text-[13px] text-muted">Overrides on top of the plan for this company only. Leave a field empty to use the plan value; -1 means unlimited.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {numericKeys.map(key => <Field key={key} label={key.replace(/_/g, ' ')} hint={`Effective: ${data.entitlements[key] === -1 ? 'unlimited' : data.entitlements[key]}`}><input type="number" min={-1} value={limits[key] ?? ''} placeholder="plan value" onChange={e => setLimits({ ...limits, [key]: e.target.value })} /></Field>)}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          {boolKeys.map(key => { const v = limits[key]; return (
            <label key={key} className="check"><select className="!w-28" value={v ?? ''} onChange={e => setLimits({ ...limits, [key]: e.target.value })} aria-label={key}><option value="">plan ({data.entitlements[key] ? 'on' : 'off'})</option><option value="true">on</option><option value="false">off</option></select><span className="capitalize">{key.replace(/_/g, ' ')}</span></label>
          ); })}
        </div>
        <div className="mt-4"><Button variant="primary" onClick={() => {
          const out: Record<string, number | boolean> = {};
          for (const [key, v] of Object.entries(limits)) { if (v === '' || v == null) continue; out[key] = v === 'true' ? true : v === 'false' ? false : Number(v); }
          void apply({ customEntitlements: Object.keys(out).length ? out : null }, 'Company limits saved');
        }}>Save limits</Button></div>
      </Card>
    </div>
  );
}

function ProfilePanel({ id, c, onSaved }: { id: string; c: any; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: c.name, industry: c.industry ?? '', website: c.website ?? '', size: c.size ?? '', email: c.email ?? '', contact_person: c.contact_person ?? '', contact_phone: c.contact_phone ?? '', country: c.country ?? '', state: c.state ?? '', address: c.address ?? '', gst_number: c.gst_number ?? '', jobCodePrefix: c.settings?.jobCodePrefix ?? '' });
  const [tags, setTags] = useState<string>((c.admin_tags || []).join(', ')); const [note, setNote] = useState('');
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
      <Card title="Company profile">
        <form className="flex flex-col gap-4" onSubmit={async e => { e.preventDefault(); try { await patch(`/admin/companies/${id}`, { ...f, jobCodePrefix: f.jobCodePrefix || undefined, admin_tags: tags.split(',').map(t => t.trim()).filter(Boolean) }); toast('Profile saved'); onSaved(); } catch (x: any) { toast(x.message, 'error'); } }}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {([['name', 'Company name'], ['industry', 'Industry'], ['website', 'Website'], ['size', 'Company size'], ['email', 'Company email'], ['contact_person', 'Contact person'], ['contact_phone', 'Contact phone'], ['country', 'Country'], ['state', 'State'], ['gst_number', 'GSTIN']] as const).map(([key, l]) => <Field key={key} label={l}><input value={(f as any)[key]} onChange={e => set(key, e.target.value)} required={key === 'name'} /></Field>)}
            <Field label="Job ID prefix"><input className="font-mono uppercase" maxLength={8} value={f.jobCodePrefix} onChange={e => set('jobCodePrefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></Field>
            <Field label="Internal tags" hint="Comma separated, e.g. VIP, Pilot, At risk"><input value={tags} onChange={e => setTags(e.target.value)} /></Field>
          </div>
          <Field label="Address"><textarea value={f.address} onChange={e => set('address', e.target.value)} /></Field>
          <div><Button variant="primary" type="submit">Save profile</Button></div>
        </form>
      </Card>
      <div className="flex flex-col gap-5">
      <Card title="Branding">
        <div className="flex items-center gap-4"><CompanyLogo name={c.name} src={c.logoUrl} size={64} />
          <div className="flex flex-wrap gap-2">
            <label className="btn sm cursor-pointer">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const fd = new FormData(); fd.append('file', f); const r = await fetch(`/api/admin/companies/${id}/logo`, { method: 'POST', body: fd, credentials: 'same-origin' }); const d = await r.json(); if (r.ok) { toast('Logo updated'); onSaved(); } else toast(d.error || 'Upload failed', 'error'); }} /></label>
            {c.logoUrl && <Button size="sm" onClick={async () => { await api('DELETE', `/admin/companies/${id}/logo`); toast('Logo removed'); onSaved(); }}>Remove</Button>}
          </div></div>
        <div className="mt-4 text-[13px] font-semibold">Theme colour</div>
        <div className="mt-2 flex flex-wrap gap-2">{THEME_PRESETS.map(p => <button key={p.hex} type="button" title={p.name} aria-label={p.name} onClick={async () => { await patch(`/admin/companies/${id}`, { themeColor: p.hex }); toast(`Theme set to ${p.name}`); onSaved(); }} className={`h-8 w-8 rounded-lg ring-2 ring-offset-2 ring-offset-surface ${c.theme === p.hex ? 'ring-ink' : 'ring-transparent'}`} style={{ background: p.hex }} />)}
          {c.theme && <Button size="sm" variant="ghost" onClick={async () => { await patch(`/admin/companies/${id}`, { themeColor: null }); toast('Default theme restored'); onSaved(); }}>Reset</Button>}</div>
        <p className="mb-0 mt-2 text-[12px] text-muted">Companies can also choose any custom colour in their own Settings → Branding.</p>
      </Card>
      <Card title={<span className="flex items-center gap-2"><StickyNote className="h-5 w-5 text-gold-500" />Internal notes</span>}>
        <form className="flex flex-col gap-2" onSubmit={async e => { e.preventDefault(); if (!note.trim()) return; try { await post(`/admin/companies/${id}/notes`, { text: note }); setNote(''); toast('Note added'); onSaved(); } catch (x: any) { toast(x.message, 'error'); } }}>
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Calls, renewals, promises made… visible to the IntervueX team only" />
          <div><Button type="submit" variant="primary" disabled={!note.trim()}>Add note</Button></div>
        </form>
        <div className="mt-4 flex flex-col gap-3">{(c.admin_notes || []).length ? c.admin_notes.map((n: any) => <div key={n.id} className="rounded-xl border border-line p-3"><div className="mb-1 flex items-center gap-2 text-[12px] text-muted"><Tag className="h-3 w-3" />{n.by} · {fmtDate(n.at)}</div><div className="whitespace-pre-wrap text-[14px]">{n.text}</div></div>) : <div className="text-[13.5px] text-muted">No notes yet.</div>}</div>
      </Card>
      </div>
    </div>
  );
}

