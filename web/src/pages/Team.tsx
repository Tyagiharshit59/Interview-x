import { useState } from 'react';
import { del, fmtDate, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ErrorBox, Field, Loading, statusBadge, useLoad, useToast, PageHeader } from '../ui';

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including billing and ownership', admin: 'Company settings, members, billing, all recruitment data', recruiter: 'Jobs, candidates, scheduling and pipeline', interviewer: 'Conducts interviews, coding, notes and feedback', hiring_manager: 'Reviews profiles, feedback, recordings; makes decisions',
};

export function Team() {
  const { can, me } = useAuth(); const toast = useToast();
  const { data, error, reload } = useLoad(() => get('/team'));
  const [inv, setInv] = useState({ email: '', role: 'interviewer' }); const [err, setErr] = useState<unknown>(null); const [dev, setDev] = useState('');
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const manage = can('members.manage');
  return (
    <div className="stack">
      <PageHeader eyebrow="Company" title="Team & permissions" description="Invite colleagues and choose what each role can do." />
      {manage && <Card title="Invite a teammate">
        <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={async e => { e.preventDefault(); setErr(null); try { const r = await post('/team/invites', inv); setInv({ ...inv, email: '' }); setDev(r.devInviteUrl || ''); toast('Invitation sent'); void reload(); } catch (x) { setErr(x); } }}>
          <div className="grow"><Field label="Email"><input type="email" required value={inv.email} onChange={e => setInv({ ...inv, email: e.target.value })} /></Field></div>
          <div><Field label="Role"><select value={inv.role} onChange={e => setInv({ ...inv, role: e.target.value })}>{['admin', 'recruiter', 'interviewer', 'hiring_manager'].map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select></Field></div>
          <Button variant="primary" type="submit">Send invite</Button>
        </form>
        <p className="small muted" style={{ marginBottom: 0 }}>{ROLE_HELP[inv.role]}</p><ErrorBox error={err} />
        {dev && <div className="alert" style={{ marginTop: 8 }}>Dev invite link: <a href={dev}>{dev}</a></div>}
      </Card>}
      <Card title="Members"><div className="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>MFA</th><th>Status</th></tr></thead><tbody>
        {data.members.map((m: any) => <tr key={m.id}><td><b>{m.name}</b><div className="small muted">{m.email}</div></td>
          <td>{manage && m.user_id !== me?.user.id && (m.role !== 'owner' || me?.role === 'owner') ? <select style={{ width: 150 }} aria-label={`Role for ${m.name}`} value={m.role} onChange={async e => { try { await patch(`/team/members/${m.id}`, { role: e.target.value }); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>{['owner', 'admin', 'recruiter', 'interviewer', 'hiring_manager'].map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select> : <Badge>{m.role.replace('_', ' ')}</Badge>}</td>
          <td>{m.mfa_enabled ? <Badge kind="ok">on</Badge> : <span className="muted small">off</span>}</td>
          <td className="row">{statusBadge(m.status)}{manage && m.user_id !== me?.user.id && <Button size="sm" onClick={async () => { try { await patch(`/team/members/${m.id}`, { status: m.status === 'active' ? 'disabled' : 'active' }); void reload(); } catch (x: any) { toast(x.message, 'error'); } }}>{m.status === 'active' ? 'Disable' : 'Enable'}</Button>}</td></tr>)}</tbody></table></div></Card>
      {data.invites.length > 0 && <Card title="Pending invitations"><table><tbody>{data.invites.map((i: any) => <tr key={i.id}><td>{i.email}</td><td>{i.role.replace('_', ' ')}</td><td className="small muted">expires {fmtDate(i.expires_at)}</td><td className="right">{manage && <Button size="sm" onClick={async () => { await del(`/team/invites/${i.id}`); void reload(); }}>Revoke</Button>}</td></tr>)}</tbody></table></Card>}
      <Card title="What each role can do"><table><tbody>{Object.entries(ROLE_HELP).map(([r, d]) => <tr key={r}><td><b>{r.replace('_', ' ')}</b></td><td>{d}</td></tr>)}</tbody></table></Card>
    </div>
  );
}
