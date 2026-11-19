import { Router } from 'express';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
import { requirePerm, tenant, ROLES } from '../auth.js';
import { wrap, parse, HttpError, newToken, sha256, addDays, bad } from '../util.js';
import { audit, sendMail, getEntitlements, usageSummary, notify } from '../services.js';
import { config } from '../config.js';

export const companyRouter = Router();

/* ---------- profile & settings ---------- */
companyRouter.get('/company', wrap((req, res) => {
  const c = db.prepare('SELECT id,name,slug,website,industry,size,gst_number,billing_address,state,settings FROM companies WHERE id=?').get(tenant(req)) as any;
  res.json({ ...c, settings: j(c.settings, {}) });
}));

companyRouter.patch('/company', requirePerm('company.manage'), wrap((req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100).optional(), website: z.string().max(200).nullable().optional(), industry: z.string().max(80).nullable().optional(),
    size: z.string().max(40).nullable().optional(), gst_number: z.string().trim().max(20).nullable().optional(),
    billing_address: z.string().max(400).nullable().optional(), state: z.string().max(60).nullable().optional(),
    settings: z.object({
      aiEnabled: z.boolean(), aiDataMinimization: z.boolean(), secondaryCameraEnabled: z.boolean(), recordingEnabled: z.boolean(),
      recordingRetentionDays: z.number().int().min(1).max(3650), requireAdminMfa: z.boolean(), timezone: z.string().max(60),
      hiringStages: z.array(z.string().min(1).max(40)).min(2).max(20),
    }).partial().optional(),
  }), req.body);
  const cur = db.prepare('SELECT * FROM companies WHERE id=?').get(tenant(req)) as any;
  const settings = { ...j(cur.settings, {}), ...(b.settings || {}) };
  const m = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'settings')) };
  if (m.gst_number && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(m.gst_number.toUpperCase())) throw bad('GSTIN format looks invalid (expected 15 characters)', 'bad_gstin');
  db.prepare('UPDATE companies SET name=?,website=?,industry=?,size=?,gst_number=?,billing_address=?,state=?,settings=? WHERE id=?')
    .run(m.name, m.website, m.industry, m.size, m.gst_number?.toUpperCase() ?? null, m.billing_address, m.state, JSON.stringify(settings), tenant(req));
  audit(tenant(req), req.auth!, 'company.updated', tenant(req), req, Object.keys(b));
  res.json({ ok: true });
}));

/* ---------- team ---------- */
companyRouter.get('/team', wrap((req, res) => {
  const members = db.prepare(`SELECT m.id, m.user_id, m.role, m.status, u.name, u.email, u.mfa_enabled FROM company_members m JOIN users u ON u.id=m.user_id
    WHERE m.company_id=? ORDER BY u.name`).all(tenant(req));
  const invites = db.prepare('SELECT id,email,role,expires_at,created_at FROM member_invites WHERE company_id=? AND accepted_at IS NULL AND expires_at>? ORDER BY created_at DESC').all(tenant(req), now());
  res.json({ members, invites });
}));

companyRouter.post('/team/invites', requirePerm('members.manage'), wrap((req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'recruiter', 'interviewer', 'hiring_manager']) }), req.body);
  const e = getEntitlements(tenant(req));
  const active = (db.prepare("SELECT COUNT(*) c FROM company_members WHERE company_id=? AND status='active'").get(tenant(req)) as any).c;
  const pending = (db.prepare('SELECT COUNT(*) c FROM member_invites WHERE company_id=? AND accepted_at IS NULL AND expires_at>?').get(tenant(req), now()) as any).c;
  if (e.members !== -1 && active + pending >= e.members) throw new HttpError(402, `Your plan includes ${e.members} team accounts. Upgrade to add more.`, 'limit_reached');
  if (db.prepare(`SELECT 1 FROM company_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND u.email=? AND m.status='active'`).get(tenant(req), b.email)) throw new HttpError(409, 'That person is already on your team');
  const raw = newToken();
  db.prepare('INSERT INTO member_invites(id,company_id,email,role,token_hash,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid(), tenant(req), b.email, b.role, sha256(raw), req.auth!.userId, addDays(7), now());
  const link = `${config.appUrl}/accept-invite?token=${raw}`;
  const co = db.prepare('SELECT name FROM companies WHERE id=?').get(tenant(req)) as any;
  void sendMail(tenant(req), b.email, `You're invited to join ${co.name} on IntervueX`, `${req.auth!.name} invited you as ${b.role}.\nAccept (valid 7 days): ${link}`);
  audit(tenant(req), req.auth!, 'member.invited', b.email, req, { role: b.role });
  res.status(201).json({ ok: true, ...(config.isProd ? {} : { devInviteUrl: link }) });
}));

companyRouter.delete('/team/invites/:id', requirePerm('members.manage'), wrap((req, res) => {
  db.prepare('DELETE FROM member_invites WHERE id=? AND company_id=?').run(req.params.id, tenant(req));
  res.json({ ok: true });
}));

companyRouter.patch('/team/members/:id', requirePerm('members.manage'), wrap((req, res) => {
  const b = parse(z.object({ role: z.enum(ROLES as [string, ...string[]]).optional(), status: z.enum(['active', 'disabled']).optional() }), req.body);
  const m = db.prepare('SELECT * FROM company_members WHERE id=? AND company_id=?').get(req.params.id, tenant(req)) as any;
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.role === 'owner' && req.auth!.role !== 'owner') throw new HttpError(403, 'Only an owner can change an owner');
  if (m.user_id === req.auth!.userId && (b.status === 'disabled' || (b.role && b.role !== m.role))) throw bad('You cannot change your own role or disable yourself');
  if (b.role === 'owner' && req.auth!.role !== 'owner') throw new HttpError(403, 'Only an owner can assign owner');
  if (m.role === 'owner' && (b.role !== 'owner' && b.role || b.status === 'disabled')) {
    const owners = (db.prepare("SELECT COUNT(*) c FROM company_members WHERE company_id=? AND role='owner' AND status='active'").get(tenant(req)) as any).c;
    if (owners <= 1) throw bad('A company needs at least one active owner');
  }
  db.prepare('UPDATE company_members SET role=?, status=? WHERE id=?').run(b.role ?? m.role, b.status ?? m.status, m.id);
  if (b.status === 'disabled') db.prepare('UPDATE users SET session_version=session_version+0 WHERE id=?').run(m.user_id); // membership is checked on every request
  audit(tenant(req), req.auth!, 'member.updated', m.user_id, req, b);
  res.json({ ok: true });
}));

/* ---------- notifications ---------- */
companyRouter.get('/notifications', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? AND (company_id=? OR company_id IS NULL) ORDER BY created_at DESC LIMIT 50').all(req.auth!.userId, tenant(req));
  const unread = (db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL AND (company_id=? OR company_id IS NULL)').get(req.auth!.userId, tenant(req)) as any).c;
  res.json({ items: rows, unread });
}));
companyRouter.post('/notifications/read', wrap((req, res) => {
  db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), req.auth!.userId);
  res.json({ ok: true });
}));
companyRouter.get('/notification-prefs', wrap((req, res) => {
  const p = db.prepare('SELECT email_enabled,reminders FROM notification_prefs WHERE user_id=?').get(req.auth!.userId) as any;
  res.json({ email_enabled: p ? !!p.email_enabled : true, reminders: p ? !!p.reminders : true });
}));
companyRouter.put('/notification-prefs', wrap((req, res) => {
  const b = parse(z.object({ email_enabled: z.boolean(), reminders: z.boolean() }), req.body);
  db.prepare('INSERT INTO notification_prefs(user_id,email_enabled,reminders) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled, reminders=excluded.reminders')
    .run(req.auth!.userId, +b.email_enabled, +b.reminders);
  res.json({ ok: true });
}));

/* ---------- audit log ---------- */
companyRouter.get('/audit', requirePerm('audit.view'), wrap((req, res) => {
  const rows = db.prepare('SELECT id,actor_label,action,target,detail,ip,created_at FROM audit_logs WHERE company_id=? ORDER BY created_at DESC LIMIT 200').all(tenant(req));
  res.json({ items: rows });
}));

/* ---------- support ---------- */
companyRouter.post('/support', wrap((req, res) => {
  const b = parse(z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(5).max(4000), allowAccessHours: z.number().int().min(0).max(72).default(0) }), req.body);
  const until = b.allowAccessHours ? new Date(Date.now() + b.allowAccessHours * 3600e3).toISOString() : null;
  db.prepare('INSERT INTO support_requests(id,company_id,user_id,subject,body,support_access_until,created_at) VALUES (?,?,?,?,?,?,?)').run(uid(), tenant(req), req.auth!.userId, b.subject, b.body, until, now());
  audit(tenant(req), req.auth!, 'support.requested', b.subject, req, { accessUntil: until });
  res.status(201).json({ ok: true });
}));

/* ---------- misc ---------- */
companyRouter.get('/usage', wrap((req, res) => res.json(usageSummary(tenant(req)))));
companyRouter.get('/entitlements', wrap((req, res) => res.json(getEntitlements(tenant(req)))));
companyRouter.get('/announcements', wrap((_req, res) => res.json(db.prepare('SELECT id,message,level FROM announcements WHERE active=1 ORDER BY created_at DESC').all())));
export { notify };
