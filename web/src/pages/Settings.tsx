import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, Users, ArrowRight } from 'lucide-react';
import { fmtDate, get, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ChipInput, ErrorBox, Field, Loading, useLoad, useToast, PageHeader } from '../ui';

export function Settings() {
  const [tab, setTab] = useState('company');
  const tabs: Array<[string, string]> = [['company', 'Company'], ['privacy', 'Recording, AI & privacy'], ['evaluation', 'Evaluation form'], ['security', 'Security'], ['notifications', 'Notifications'], ['audit', 'Audit log'], ['support', 'Support']];
  return (
    <div className="stack">
      <PageHeader eyebrow="Company" title="Settings" description="Company profile, hiring stages, recording, AI and security policies." />
      <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'company' && <CompanyTab />}{tab === 'privacy' && <PrivacyTab />}{tab === 'evaluation' && <EvalTab />}{tab === 'security' && <SecurityTab />}{tab === 'notifications' && <NotifTab />}{tab === 'audit' && <AuditTab />}{tab === 'support' && <SupportTab />}
    </div>
  );
}

function CompanyTab() {
  const toast = useToast(); const { refresh } = useAuth();
  const { data, error } = useLoad(() => get('/company')); const [f, setF] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return error ? <ErrorBox error={error} /> : <Loading />;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  return (
    <div className="flex flex-col gap-5">
    <TeamAccountsCard />
    <Card title="Company profile & billing details">
      <form className="stack" onSubmit={async e => { e.preventDefault(); setErr(null); try { await patch('/company', { ...(f.settings?.jobCodePrefix ? { settings: { jobCodePrefix: f.settings.jobCodePrefix } } : {}), name: f.name, website: f.website || null, industry: f.industry || null, size: f.size || null, gst_number: f.gst_number || null, billing_address: f.billing_address || null, state: f.state || null }); toast('Saved'); void refresh(); } catch (x) { setErr(x); } }}>
        <ErrorBox error={err} />
        <div className="grid g2"><Field label="Company name"><input required value={f.name} onChange={e => set('name', e.target.value)} /></Field><Field label="Website"><input value={f.website || ''} onChange={e => set('website', e.target.value)} /></Field>
          <Field label="Industry"><input value={f.industry || ''} onChange={e => set('industry', e.target.value)} /></Field><Field label="Company size"><select value={f.size || ''} onChange={e => set('size', e.target.value)}><option value="">—</option><option>1-10</option><option>11-50</option><option>51-200</option><option>201-1000</option><option>1000+</option></select></Field>
          <Field label="GSTIN (India)" hint="Printed on GST invoices"><input value={f.gst_number || ''} onChange={e => set('gst_number', e.target.value.toUpperCase())} maxLength={15} /></Field>
          <Field label="State" hint="Decides CGST+SGST vs IGST"><input value={f.state || ''} onChange={e => set('state', e.target.value)} /></Field>
          <Field label="Job ID prefix" hint={`2–8 letters or digits. New jobs get IDs like ${(f.settings?.jobCodePrefix || 'JOB').toUpperCase()}-${(f.nextJobCode || '-0001').split('-').pop()}. Existing job IDs never change.`}><input value={f.settings?.jobCodePrefix || ''} maxLength={8} onChange={e => setF({ ...f, settings: { ...f.settings, jobCodePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') } })} className="font-mono uppercase" /></Field></div>
        <Field label="Billing address"><textarea value={f.billing_address || ''} onChange={e => set('billing_address', e.target.value)} /></Field>
        <div><Button variant="primary" type="submit">Save</Button></div>
      </form>
    </Card>
    </div>
  );
}

/** Shortcut from the company profile to creating user accounts (HR, recruiters, interviewers…). */
function TeamAccountsCard() {
  const { can } = useAuth();
  const { data } = useLoad(() => get('/team'));
  const members = data?.members || [];
  const pending = members.filter((m: any) => m.pending_activation).length;
  return (
    <div className="relative overflow-hidden rounded-2xl bg-night-gradient p-6 text-white shadow-lift">
      <div className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full bg-brand-500/30 blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-white/10 text-gold-300 ring-1 ring-white/10"><Users className="h-6 w-6" /></span>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-300">Team & user accounts</div>
            <div className="mt-1 text-[17px] font-bold text-white">Create logins for your HR team, recruiters and interviewers</div>
            <div className="mt-0.5 text-[13px] text-slate-400">{members.length} member{members.length === 1 ? '' : 's'}{pending ? ` · ${pending} awaiting activation` : ''}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('members.manage') && <Link className="btn gold" to="/team?add=1"><UserPlus className="h-4 w-4" />Add team member</Link>}
          <Link className="btn !border-white/15 !bg-white/10 !text-white hover:!bg-white/20" to="/team">Manage team <ArrowRight className="h-4 w-4" /></Link>
        </div>
      </div>
    </div>
  );
}

function PrivacyTab() {
  const toast = useToast(); const { refresh } = useAuth(); const { data } = useLoad(() => get('/company')); const [s, setS] = useState<any>(null); const [stages, setStages] = useState<string[]>([]);
  useEffect(() => { if (data) { setS(data.settings); setStages(data.settings.hiringStages || []); } }, [data]);
  if (!s) return <Loading />;
  const set = (k: string, v: any) => setS({ ...s, [k]: v });
  const Toggle = ({ k, label, help }: { k: string; label: string; help: string }) => <label className="check"><input type="checkbox" checked={!!s[k]} onChange={e => set(k, e.target.checked)} /><span><b>{label}</b><br /><span className="muted small">{help}</span></span></label>;
  return (
    <Card title="Recording, AI & data controls">
      <div className="stack">
        <Toggle k="recordingEnabled" label="Allow interview recording" help="Interviewers can still only record after the candidate gives consent in the room." />
        <Toggle k="secondaryCameraEnabled" label="Allow secondary phone camera" help="Optional per interview. Always requires candidate consent and browser permission." />
        <Toggle k="aiEnabled" label="Enable AI assistance" help="Question ideas, summaries and feedback drafts. Never automates decisions." />
        <Toggle k="aiDataMinimization" label="Minimise data sent to AI providers" help="Removes candidate names from text before it leaves the platform." />
        <Field label="Recording retention (days)" hint="Recordings are deleted automatically after this period (capped by your plan)."><input type="number" min={1} max={3650} style={{ maxWidth: 160 }} value={s.recordingRetentionDays} onChange={e => set('recordingRetentionDays', Number(e.target.value))} /></Field>
        <Field label="Hiring stages" hint="Order matters. Keep 'Selected', 'Rejected' and 'On Hold' for decisions."><ChipInput value={stages} onChange={setStages} /></Field>
        <div className="alert">This product aims to support data-protection duties but does not by itself make you compliant with India's DPDP Act or other laws. Have your notices and retention periods reviewed by qualified counsel.</div>
        <div><Button variant="primary" onClick={async () => { try { await patch('/company', { settings: { ...s, hiringStages: stages.map(x => x.replace(/\b\w/g, c => c.toUpperCase())) } }); toast('Saved'); void refresh(); } catch (e: any) { toast(e.message, 'error'); } }}>Save</Button></div>
      </div>
    </Card>
  );
}

function EvalTab() {
  const toast = useToast(); const { data } = useLoad(() => get('/evaluation-template')); const [c, setC] = useState<string[]>([]);
  useEffect(() => { if (data) setC(data.criteria); }, [data]);
  return <Card title="Evaluation criteria"><p className="muted small">Interviewers rate each criterion from 1–5 and must add evidence-based notes. Customising criteria may require the Business plan.</p><ChipInput value={c.map(x => x)} onChange={v => setC(v.map(x => x.replace(/^./, ch => ch.toUpperCase())))} /><div style={{ marginTop: 12 }}><Button variant="primary" onClick={async () => { try { await put('/evaluation-template', { criteria: c }); toast('Saved'); } catch (e: any) { toast(e.message, 'error'); } }}>Save criteria</Button></div></Card>;
}

function SecurityTab() {
  const { me, refresh } = useAuth(); const toast = useToast(); const [setup, setSetup] = useState<any>(null); const [code, setCode] = useState(''); const [pw, setPw] = useState({ current: '', password: '' }); const [err, setErr] = useState<unknown>(null);
  const { data } = useLoad(() => get('/company')); const [req, setReq] = useState(false); useEffect(() => { if (data) setReq(!!data.settings.requireAdminMfa); }, [data]);
  return (
    <div className="stack">
      <Card title="Two-factor authentication (TOTP)">
        <ErrorBox error={err} />
        {me?.user.mfaEnabled ? <div className="stack"><Badge kind="ok">Enabled</Badge><form className="row" onSubmit={async e => { e.preventDefault(); try { await post('/auth/mfa/disable', { password: pw.current, code }); toast('MFA disabled'); void refresh(); } catch (x) { setErr(x); } }}><input type="password" placeholder="Password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} aria-label="Password" /><input placeholder="6-digit code" maxLength={6} value={code} onChange={e => setCode(e.target.value)} aria-label="Code" style={{ maxWidth: 140 }} /><Button type="submit" variant="danger">Disable</Button></form></div>
          : setup ? <div className="stack"><p>Scan with an authenticator app, then enter the 6-digit code.</p><img src={setup.qr} alt="MFA QR code" width={180} height={180} /><div className="small mono">Secret: {setup.secret}</div><form className="row" onSubmit={async e => { e.preventDefault(); try { await post('/auth/mfa/enable', { code }); toast('MFA enabled'); setSetup(null); void refresh(); } catch (x) { setErr(x); } }}><input value={code} maxLength={6} inputMode="numeric" onChange={e => setCode(e.target.value)} style={{ maxWidth: 140 }} aria-label="Code" /><Button variant="primary" type="submit">Enable</Button></form></div>
            : <Button variant="primary" onClick={async () => setSetup(await post('/auth/mfa/setup'))}>Set up MFA</Button>}
      </Card>
      {['owner', 'admin'].includes(me?.role || '') && <Card title="Company policy"><label className="check"><input type="checkbox" checked={req} onChange={async e => { setReq(e.target.checked); await patch('/company', { settings: { requireAdminMfa: e.target.checked } }); }} /><span><b>Require MFA for owners and admins</b><br /><span className="muted small">Admins without MFA are prompted to enrol at sign-in.</span></span></label></Card>}
      <Card title="Change password"><form className="row" style={{ alignItems: 'flex-end' }} onSubmit={async e => { e.preventDefault(); setErr(null); try { await post('/auth/change-password', pw); toast('Password changed'); setPw({ current: '', password: '' }); } catch (x) { setErr(x); } }}><Field label="Current"><input type="password" required value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></Field><Field label="New"><input type="password" required value={pw.password} onChange={e => setPw({ ...pw, password: e.target.value })} /></Field><Button type="submit">Update</Button></form></Card>
    </div>
  );
}

function NotifTab() {
  const toast = useToast(); const { data } = useLoad(() => get('/notification-prefs')); const [p, setP] = useState<any>(null); useEffect(() => { if (data) setP(data); }, [data]);
  if (!p) return <Loading />;
  return <Card title="Notification preferences"><div className="stack"><label className="check"><input type="checkbox" checked={p.email_enabled} onChange={e => setP({ ...p, email_enabled: e.target.checked })} />Email me about interviews, evaluations and billing</label><label className="check"><input type="checkbox" checked={p.reminders} onChange={e => setP({ ...p, reminders: e.target.checked })} />Interview reminders (24 hours and 1 hour before)</label><div><Button variant="primary" onClick={async () => { await put('/notification-prefs', p); toast('Saved'); }}>Save</Button></div><p className="small muted">SMS and WhatsApp reminders are consent-based optional add-ons and are not enabled in this build.</p></div></Card>;
}

function AuditTab() {
  const { data, error } = useLoad(() => get('/audit'));
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  return <Card title="Audit log (latest 200)"><div className="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>{data.items.map((a: any) => <tr key={a.id}><td className="small">{fmtDate(a.created_at)}</td><td className="small">{a.actor_label || 'system'}</td><td><Badge>{a.action}</Badge></td><td className="small mono">{(a.target || '').slice(0, 40)}</td><td className="small">{a.ip}</td></tr>)}</tbody></table></div></Card>;
}

function SupportTab() {
  const toast = useToast(); const [f, setF] = useState({ subject: '', body: '', allowAccessHours: 0 }); const [err, setErr] = useState<unknown>(null);
  return <Card title="Contact support"><form className="stack" onSubmit={async e => { e.preventDefault(); setErr(null); try { await post('/support', { ...f, allowAccessHours: Number(f.allowAccessHours) }); toast('Request sent'); setF({ subject: '', body: '', allowAccessHours: 0 }); } catch (x) { setErr(x); } }}><ErrorBox error={err} /><Field label="Subject"><input required value={f.subject} onChange={e => setF({ ...f, subject: e.target.value })} /></Field><Field label="Describe the issue"><textarea required value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></Field>
    <Field label="Allow read-only support access to my account" hint="Time-boxed. Every action is audited. Choose 0 for none."><select value={f.allowAccessHours} onChange={e => setF({ ...f, allowAccessHours: Number(e.target.value) })}><option value={0}>No access</option><option value={4}>4 hours</option><option value={24}>24 hours</option><option value={72}>72 hours</option></select></Field><div><Button variant="primary" type="submit">Send</Button></div></form></Card>;
}
