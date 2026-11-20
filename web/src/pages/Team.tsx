import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UserPlus, Mail, ShieldCheck, Briefcase, Users, Video, Gavel, Crown, Send, Copy, Check, Clock, Gift } from 'lucide-react';
import { del, fmtDate, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, statusBadge, useLoad, useToast, PageHeader } from '../ui';

export const ROLE_INFO: Record<string, { label: string; help: string; icon: any }> = {
  owner: { label: 'Owner', help: 'Everything, including billing and ownership', icon: Crown },
  admin: { label: 'Admin', help: 'Company settings, team, billing and all recruitment data', icon: ShieldCheck },
  hr: { label: 'HR', help: 'Jobs, candidates, scheduling, HR rounds, all feedback, analytics and exports', icon: Users },
  recruiter: { label: 'Recruiter', help: 'Jobs, candidates, scheduling and the pipeline', icon: Briefcase },
  interviewer: { label: 'Interviewer', help: 'Conducts interviews, coding, notes and feedback', icon: Video },
  hiring_manager: { label: 'Hiring manager', help: 'Reviews profiles, feedback and recordings; makes the final decision', icon: Gavel },
  employee: { label: 'Employee (referrals)', help: 'Refers candidates and tracks referral bonuses. No access to hiring data', icon: Gift },
};
const ASSIGNABLE = ['hr', 'recruiter', 'interviewer', 'hiring_manager', 'admin', 'employee'];
const roleLabel = (r: string) => ROLE_INFO[r]?.label ?? r.replace('_', ' ');
const initials = (n: string) => n.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();

export function AddMember({ onClose, onDone, roles = ASSIGNABLE, title = 'Add a team member' }: { onClose: () => void; onDone: () => void; roles?: string[]; title?: string }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', role: roles[0], designation: '', phone: '' });
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { email: string; newAccount: boolean; link?: string }>(null);
  const [copied, setCopied] = useState(false);
  const fe = (p: string) => err?.details?.find?.((d: any) => d.path === p)?.message;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await post('/team/members', { ...f, designation: f.designation || null, phone: f.phone || null });
      setDone({ email: f.email, newAccount: r.newAccount, link: r.devActivateUrl }); toast(r.newAccount ? 'Account created, activation email sent' : 'Added to your team'); onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (done) return (
    <Modal title="Team member added" onClose={onClose}>
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-ok/10 text-ok ring-1 ring-ok/25"><Check className="h-7 w-7" /></span>
        {done.newAccount ? <p className="mb-0">We created the account for <b>{done.email}</b> and emailed a secure activation link. They choose their own password; the link works once and expires in 7 days.</p>
          : <p className="mb-0"><b>{done.email}</b> already had an IntervueX account, so we added them to your company. They can sign in right away.</p>}
        {done.link && (
          <div className="w-full rounded-xl border border-line bg-raised/60 p-3 text-left">
            <div className="mb-1.5 text-[12px] font-semibold text-muted">Development only: activation link (email is not configured)</div>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-[12.5px]">{done.link}</code>
              <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(done.link!); setCopied(true); }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</Button></div>
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={() => { setDone(null); setF({ name: '', email: '', role: f.role, designation: '', phone: '' }); }}>Add another</Button><Button variant="primary" onClick={onClose}>Done</Button></div>
    </Modal>
  );
  return (
    <Modal title={title} onClose={onClose} wide>
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <p className="mb-0 text-[14px] text-muted">Create a login for a colleague, such as your HR team. They'll get an email to set their own password. Passwords are never sent by email.</p>
        {err && !err.details && <ErrorBox error={err} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Full name" error={fe('name')}><input required autoFocus value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Priya Sharma" /></Field>
          <Field label="Work email" error={fe('email')}><input type="email" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} placeholder="priya@company.com" /></Field>
          <Field label="Designation" hint="Optional, e.g. HR Business Partner"><input value={f.designation} onChange={e => setF({ ...f, designation: e.target.value })} /></Field>
          <Field label="Phone" hint="Optional"><input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 text-[13px] font-semibold">Role</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {roles.map(r => { const I = ROLE_INFO[r].icon; const on = f.role === r; return (
              <label key={r} className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition ${on ? 'border-brand-400 bg-brand-500/[0.06] shadow-ring' : 'border-line hover:border-brand-200 hover:bg-raised/60'}`}>
                <input type="radio" name="role" className="sr-only" checked={on} onChange={() => setF({ ...f, role: r })} />
                <span className={`grid h-9 w-9 flex-none place-items-center rounded-xl ${on ? 'bg-brand-gradient text-white shadow-glow' : 'bg-raised text-muted'}`}><I className="h-[18px] w-[18px]" /></span>
                <span><span className="block text-[14px] font-semibold">{ROLE_INFO[r].label}</span><span className="block text-[12.5px] leading-snug text-muted">{ROLE_INFO[r].help}</span></span>
              </label>
            ); })}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" busy={busy}><UserPlus className="h-4 w-4" />Create account</Button></div>
      </form>
    </Modal>
  );
}

function InviteByLink({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [inv, setInv] = useState({ email: '', role: 'hr' }); const [err, setErr] = useState<unknown>(null); const [dev, setDev] = useState('');
  return (
    <Card title="Or send an invitation link (hiring team)" actions={<span className="text-[12.5px] text-muted">They create their own account</span>}>
      <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={async e => { e.preventDefault(); setErr(null); try { const r = await post('/team/invites', inv); setInv({ ...inv, email: '' }); setDev(r.devInviteUrl || ''); toast('Invitation sent'); onDone(); } catch (x) { setErr(x); } }}>
        <div className="flex-1"><Field label="Email"><input type="email" required value={inv.email} onChange={e => setInv({ ...inv, email: e.target.value })} /></Field></div>
        <div className="sm:w-48"><Field label="Role"><select value={inv.role} onChange={e => setInv({ ...inv, role: e.target.value })}>{ASSIGNABLE.filter(r => r !== 'employee').map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></Field></div>
        <Button type="submit"><Send className="h-4 w-4" />Send invite</Button>
      </form>
      <div className="mt-3"><ErrorBox error={err} /></div>
      {dev && <div className="alert mt-2 break-all">Dev invite link: <a href={dev}>{dev}</a></div>}
    </Card>
  );
}

export function Team() {
  const { can, me } = useAuth(); const toast = useToast();
  const { data, error, reload } = useLoad(() => get('/team'));
  const [sp, setSp] = useSearchParams();
  const [adding, setAddingState] = useState(sp.get('add') === '1');
  const setAdding = (v: boolean) => { setAddingState(v); if (!v && sp.get('add')) { sp.delete('add'); setSp(sp, { replace: true }); } };
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const manage = can('members.manage'); const empManage = can('employees.manage');
  const addRoles = manage ? ASSIGNABLE : empManage ? ['employee'] : [];
  const counts = { total: data.members.length, active: data.members.filter((m: any) => m.status === 'active' && !m.pending_activation).length, pending: data.members.filter((m: any) => m.pending_activation).length + data.invites.length };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Company" title="Team & permissions" description="Create accounts for your HR team, recruiters and interviewers, and control what each role can do."
        actions={addRoles.length > 0 && <Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" />{manage ? 'Add team member' : 'Add employee'}</Button>} />
      {adding && <AddMember roles={addRoles} title={manage ? 'Add a team member' : 'Add an employee (referral portal)'} onClose={() => setAdding(false)} onDone={() => void reload()} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[['Team members', counts.total, Users], ['Active', counts.active, Check], ['Awaiting activation', counts.pending, Clock]].map(([l, v, I]: any) => (
          <div key={l} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 shadow-soft">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-500/10 text-brand-600 ring-1 ring-brand-500/20 dark:text-brand-300"><I className="h-5 w-5" /></span>
            <div><div className="text-2xl font-extrabold leading-none">{v}</div><div className="mt-1 text-[13px] font-semibold text-muted">{l}</div></div>
          </div>
        ))}
      </div>

      <Card title="Members">
        <div className="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Status</th><th className="right">Actions</th></tr></thead><tbody>
          {data.members.map((m: any) => {
            const editable = manage && m.user_id !== me?.user.id && (m.role !== 'owner' || me?.role === 'owner');
            const empRow = !manage && empManage && m.role === 'employee';
            return (
              <tr key={m.id}>
                <td>
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-gradient-to-br from-brand-500/15 to-gold-400/20 text-[13px] font-bold text-brand-700 dark:text-brand-200">{initials(m.name)}</span>
                    <div className="min-w-0"><div className="truncate font-semibold">{m.name}{m.user_id === me?.user.id && <span className="ml-1.5 text-[12px] font-medium text-muted">(you)</span>}</div>
                      <div className="truncate text-[12.5px] text-muted">{m.email}{m.designation ? ` · ${m.designation}` : ''}</div></div>
                  </div>
                </td>
                <td>{editable ? (
                  <select className="!w-44" aria-label={`Role for ${m.name}`} value={m.role} onChange={async e => { try { await patch(`/team/members/${m.id}`, { role: e.target.value }); toast('Role updated'); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>
                    {['owner', ...ASSIGNABLE].map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                  </select>) : <Badge kind="primary">{roleLabel(m.role)}</Badge>}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {m.pending_activation ? <Badge kind="warn">Awaiting activation</Badge> : statusBadge(m.status)}
                    {m.mfa_enabled ? <Badge kind="ok">MFA</Badge> : null}
                  </div>
                </td>
                <td className="right">
                  <div className="flex justify-end gap-2">
                    {(manage || empRow) && m.pending_activation && <Button size="sm" onClick={async () => { try { const r = await post(`/team/members/${m.id}/resend-activation`); toast('Activation email sent again'); if (r.devActivateUrl) void navigator.clipboard?.writeText(r.devActivateUrl); } catch (x: any) { toast(x.message, 'error'); } }}><Mail className="h-3.5 w-3.5" />Resend</Button>}
                    {(editable || empRow) && <Button size="sm" variant={m.status === 'active' ? undefined : 'primary'} onClick={async () => { try { await patch(`/team/members/${m.id}`, { status: m.status === 'active' ? 'disabled' : 'active' }); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>{m.status === 'active' ? 'Disable' : 'Enable'}</Button>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody></table></div>
      </Card>

      {manage && <InviteByLink onDone={() => void reload()} />}

      {data.invites.length > 0 && <Card title="Pending invitations"><div className="table-wrap"><table><tbody>{data.invites.map((i: any) => <tr key={i.id}><td className="font-medium">{i.email}</td><td><Badge>{roleLabel(i.role)}</Badge></td><td className="small muted">expires {fmtDate(i.expires_at)}</td><td className="right">{manage && <Button size="sm" onClick={async () => { await del(`/team/invites/${i.id}`); void reload(); }}>Revoke</Button>}</td></tr>)}</tbody></table></div></Card>}

      <Card title="What each role can do">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(ROLE_INFO).map(([r, info]) => { const I = info.icon; return (
            <div key={r} className="flex items-start gap-3 rounded-xl border border-line p-3.5">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-raised text-brand-600 dark:text-brand-300"><I className="h-[18px] w-[18px]" /></span>
              <div><div className="text-[14px] font-semibold">{info.label}</div><div className="text-[13px] leading-snug text-muted">{info.help}</div></div>
            </div>
          ); })}
        </div>
      </Card>
    </div>
  );
}
