import { Router } from 'express';
import { z } from 'zod';
import { db, now, j, tx, isDuplicateKey } from '../db.js';
import { requirePerm, tenant, ROLES } from '../auth.js';
import { wrap, parse, HttpError, newToken, sha256, addDays, bad } from '../util.js';
import { createAccountToken } from './auth.js';
import { audit, sendMail, getEntitlements, usageSummary, notify } from '../services.js';
import { config } from '../config.js';

export const companyRouter = Router();

/* ---------- profile & settings ---------- */
companyRouter.get('/company', wrap(async (req, res) => {
  const c = await db.companies.get({ id: tenant(req) }, { projection: { name: 1, slug: 1, website: 1, industry: 1, size: 1, gst_number: 1, billing_address: 1, state: 1, settings: 1 } });
  res.json({ ...c, settings: j(c.settings, {}) });
}));

companyRouter.patch('/company', requirePerm('company.manage'), wrap(async (req, res) => {
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
  const cur = await db.companies.get({ id: tenant(req) });
  const settings = { ...j(cur.settings, {}), ...(b.settings || {}) };
  const m = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'settings')) } as any;
  if (m.gst_number && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(m.gst_number.toUpperCase())) throw bad('GSTIN format looks invalid (expected 15 characters)', 'bad_gstin');
  await db.companies.set({ id: tenant(req) }, {
    name: m.name, website: m.website ?? null, industry: m.industry ?? null, size: m.size ?? null, gst_number: m.gst_number?.toUpperCase() ?? null,
    billing_address: m.billing_address ?? null, state: m.state ?? null, settings: JSON.stringify(settings),
  });
  await audit(tenant(req), req.auth!, 'company.updated', tenant(req), req, Object.keys(b));
  res.json({ ok: true });
}));

/* ---------- team ---------- */
companyRouter.get('/team', wrap(async (req, res) => {
  const ms = await db.company_members.list({ company_id: tenant(req) });
  const users = ms.length ? await db.users.list({ id: { $in: ms.map((m: any) => m.user_id) } }) : [];
  const byId = new Map<string, any>(users.map((u: any) => [u.id, u]));
  const members = ms.filter((m: any) => byId.has(m.user_id)).map((m: any) => {
    const u = byId.get(m.user_id);
    return { id: m.id, user_id: m.user_id, role: m.role, status: m.status, name: u.name, email: u.email, mfa_enabled: u.mfa_enabled,
      designation: m.designation ?? null, phone: u.phone ?? null, pending_activation: !u.password_hash, created_at: m.created_at };
  }).sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const invites = await db.member_invites.list({ company_id: tenant(req), accepted_at: null, expires_at: { $gt: now() } },
    { sort: { created_at: -1 }, projection: { email: 1, role: 1, expires_at: 1, created_at: 1 } });
  res.json({ members, invites });
}));

companyRouter.post('/team/invites', requirePerm('members.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'hr', 'recruiter', 'interviewer', 'hiring_manager']) }), req.body);
  await assertSeat(tenant(req));
  const existing = await db.users.get({ email: b.email });
  if (existing && await db.company_members.exists({ company_id: tenant(req), user_id: existing.id, status: 'active' })) throw new HttpError(409, 'That person is already on your team');
  const raw = newToken();
  await db.member_invites.insert({ company_id: tenant(req), email: b.email, role: b.role, token_hash: sha256(raw), invited_by: req.auth!.userId, expires_at: addDays(7), accepted_at: null, created_at: now() });
  const link = `${config.appUrl}/accept-invite?token=${raw}`;
  const co = await db.companies.get({ id: tenant(req) });
  void sendMail(tenant(req), b.email, `You're invited to join ${co.name} on IntervueX`, `${req.auth!.name} invited you as ${b.role}.\nAccept (valid 7 days): ${link}`);
  await audit(tenant(req), req.auth!, 'member.invited', b.email, req, { role: b.role });
  res.status(201).json({ ok: true, ...(config.isProd ? {} : { devInviteUrl: link }) });
}));

/** Seat check shared by invites and direct account creation. */
async function assertSeat(cid: string) {
  const e = await getEntitlements(cid);
  const active = await db.company_members.count({ company_id: cid, status: 'active' });
  const pending = await db.member_invites.count({ company_id: cid, accepted_at: null, expires_at: { $gt: now() } });
  if (e.members !== -1 && active + pending >= e.members) throw new HttpError(402, `Your plan includes ${e.members} team accounts. Upgrade to add more.`, 'limit_reached');
}

async function sendActivation(cid: string, user: { id: string; email: string; name: string }, role: string, inviter: string) {
  const raw = await createAccountToken(user.id, 'activate_account', 60 * 24 * 7, { companyId: cid });
  const link = `${config.appUrl}/activate?token=${raw}`;
  const co = await db.companies.get({ id: cid });
  void sendMail(cid, user.email, `Your IntervueX account at ${co.name}`,
    `Hi ${user.name},\n\n${inviter} created an IntervueX account for you at ${co.name} (role: ${role.replace('_', ' ')}).\n\nSet your password to activate it (link valid for 7 days, single use):\n${link}\n\nIf you were not expecting this, you can ignore this email.`);
  return link;
}

/**
 * Company admin creates a team member's account directly (e.g. HR, recruiters, interviewers).
 * No password is set or emailed: the person receives a single-use, 7-day activation link and chooses their own password.
 * If the email already has an IntervueX account, they are simply added to this company.
 */
companyRouter.post('/team/members', requirePerm('members.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const b = parse(z.object({
    name: z.string().trim().min(2, 'Enter the full name').max(100), email: z.string().trim().toLowerCase().email(),
    role: z.enum(['admin', 'hr', 'recruiter', 'interviewer', 'hiring_manager']),
    designation: z.string().trim().max(80).optional().nullable(), phone: z.string().trim().max(30).optional().nullable(),
  }), req.body);
  await assertSeat(cid);
  const existing = await db.users.get({ email: b.email });
  if (existing && await db.company_members.exists({ company_id: cid, user_id: existing.id })) throw new HttpError(409, 'That person is already on your team', 'already_member');
  let devActivateUrl: string | undefined;
  let userId = existing?.id as string | undefined;
  try {
    await tx(async () => {
      if (!userId) {
        userId = await db.users.insert({ email: b.email, password_hash: '', name: b.name, phone: b.phone || null, is_super_admin: 0, email_verified: 0, mfa_secret: null, mfa_enabled: 0, failed_logins: 0, locked_until: null, session_version: 0, created_by: req.auth!.userId, created_at: now() });
      }
      await db.company_members.insert({ company_id: cid, user_id: userId, role: b.role, status: 'active', designation: b.designation || null, added_by: req.auth!.userId, created_at: now() });
    });
  } catch (e) { if (isDuplicateKey(e)) throw new HttpError(409, 'That person is already on your team', 'already_member'); throw e; }
  const co = await db.companies.get({ id: cid });
  if (!existing || !existing.password_hash) devActivateUrl = await sendActivation(cid, { id: userId!, email: b.email, name: existing?.name || b.name }, b.role, req.auth!.name);
  else {
    void sendMail(cid, b.email, `You've been added to ${co.name} on IntervueX`, `${req.auth!.name} added you to ${co.name} as ${b.role.replace('_', ' ')}.\nSign in with your existing account: ${config.appUrl}/login`);
    await notify(cid, userId!, 'team', `You were added to ${co.name}`, `Role: ${b.role.replace('_', ' ')}`, '/dashboard');
  }
  await audit(cid, req.auth!, 'member.created', userId, req, { email: b.email, role: b.role, newAccount: !existing });
  res.status(201).json({ ok: true, userId, newAccount: !existing, ...(config.isProd ? {} : { devActivateUrl }) });
}));

companyRouter.post('/team/members/:id/resend-activation', requirePerm('members.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const m = await db.company_members.get({ id: req.params.id, company_id: cid });
  if (!m) throw new HttpError(404, 'Member not found');
  const u = await db.users.get({ id: m.user_id });
  if (!u || u.password_hash) throw bad('This account is already active');
  await db.user_tokens.setMany({ user_id: u.id, purpose: 'activate_account', used_at: null }, { used_at: now() }); // old links stop working
  const link = await sendActivation(cid, u, m.role, req.auth!.name);
  await audit(cid, req.auth!, 'member.activation_resent', u.id, req);
  res.json({ ok: true, ...(config.isProd ? {} : { devActivateUrl: link }) });
}));

companyRouter.delete('/team/invites/:id', requirePerm('members.manage'), wrap(async (req, res) => {
  await db.member_invites.del({ id: req.params.id, company_id: tenant(req) });
  res.json({ ok: true });
}));

companyRouter.patch('/team/members/:id', requirePerm('members.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ role: z.enum(ROLES as [string, ...string[]]).optional(), status: z.enum(['active', 'disabled']).optional(), designation: z.string().trim().max(80).nullable().optional() }), req.body);
  const m = await db.company_members.get({ id: req.params.id, company_id: tenant(req) });
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.role === 'owner' && req.auth!.role !== 'owner') throw new HttpError(403, 'Only an owner can change an owner');
  if (m.user_id === req.auth!.userId && (b.status === 'disabled' || (b.role && b.role !== m.role))) throw bad('You cannot change your own role or disable yourself');
  if (b.role === 'owner' && req.auth!.role !== 'owner') throw new HttpError(403, 'Only an owner can assign owner');
  if (m.role === 'owner' && (b.role !== 'owner' && b.role || b.status === 'disabled')) {
    const owners = await db.company_members.count({ company_id: tenant(req), role: 'owner', status: 'active' });
    if (owners <= 1) throw bad('A company needs at least one active owner');
  }
  await db.company_members.set({ id: m.id, company_id: tenant(req) }, { role: b.role ?? m.role, status: b.status ?? m.status, ...(b.designation !== undefined ? { designation: b.designation || null } : {}) });
  // (old code ran a no-op `session_version+0` update on disable; membership is checked on every request, so nothing to do)
  await audit(tenant(req), req.auth!, 'member.updated', m.user_id, req, b);
  res.json({ ok: true });
}));

/* ---------- notifications ---------- */
const notifScope = (req: any) => ({ user_id: req.auth!.userId, $or: [{ company_id: tenant(req) }, { company_id: null }] });
companyRouter.get('/notifications', wrap(async (req, res) => {
  const rows = await db.notifications.list(notifScope(req), { sort: { created_at: -1 }, limit: 50 });
  const unread = await db.notifications.count({ ...notifScope(req), read_at: null });
  res.json({ items: rows, unread });
}));
companyRouter.post('/notifications/read', wrap(async (req, res) => {
  await db.notifications.setMany({ user_id: req.auth!.userId, read_at: null }, { read_at: now() });
  res.json({ ok: true });
}));
companyRouter.get('/notification-prefs', wrap(async (req, res) => {
  const p = await db.notification_prefs.get({ user_id: req.auth!.userId });
  res.json({ email_enabled: p ? !!p.email_enabled : true, reminders: p ? !!p.reminders : true });
}));
companyRouter.put('/notification-prefs', wrap(async (req, res) => {
  const b = parse(z.object({ email_enabled: z.boolean(), reminders: z.boolean() }), req.body);
  await db.notification_prefs.upsert({ user_id: req.auth!.userId }, { email_enabled: +b.email_enabled, reminders: +b.reminders });
  res.json({ ok: true });
}));

/* ---------- audit log ---------- */
companyRouter.get('/audit', requirePerm('audit.view'), wrap(async (req, res) => {
  const rows = await db.audit_logs.list({ company_id: tenant(req) }, { sort: { created_at: -1 }, limit: 200, projection: { actor_label: 1, action: 1, target: 1, detail: 1, ip: 1, created_at: 1 } });
  res.json({ items: rows });
}));

/* ---------- support ---------- */
companyRouter.post('/support', wrap(async (req, res) => {
  const b = parse(z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(5).max(4000), allowAccessHours: z.number().int().min(0).max(72).default(0) }), req.body);
  const until = b.allowAccessHours ? new Date(Date.now() + b.allowAccessHours * 3600e3).toISOString() : null;
  await db.support_requests.insert({ company_id: tenant(req), user_id: req.auth!.userId, subject: b.subject, body: b.body, status: 'open', support_access_until: until, created_at: now() });
  await audit(tenant(req), req.auth!, 'support.requested', b.subject, req, { accessUntil: until });
  res.status(201).json({ ok: true });
}));

/* ---------- misc ---------- */
companyRouter.get('/usage', wrap(async (req, res) => res.json(await usageSummary(tenant(req)))));
companyRouter.get('/entitlements', wrap(async (req, res) => res.json(await getEntitlements(tenant(req)))));
companyRouter.get('/announcements', wrap(async (_req, res) => res.json(await db.announcements.list({ active: 1 }, { sort: { created_at: -1 }, projection: { message: 1, level: 1 } }))));
export { notify };
