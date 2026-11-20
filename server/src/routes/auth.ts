import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db, tx, isDuplicateKey, uid, now, j } from '../db.js';
import { config } from '../config.js';
import { COOKIE, issueSession, requireAuth, can } from '../auth.js';
import { wrap, parse, bad, HttpError, newToken, sha256, addMinutes, addDays, isExpired, slugify, newTotpSecret, verifyTotp } from '../util.js';
import { audit, sendMail, notify } from '../services.js';
import { PERMS } from '../auth.js';
import { seedStarterQuestions } from './coding.js';
import { logoUrl } from '../branding.js';

export const authRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isProd ? 30 : 300, standardHeaders: true, legacyHeaders: false });
authRouter.use(limiter);

const password = z.string().min(8, 'At least 8 characters').max(128).regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');

async function createToken(userId: string, purpose: string, minutes: number, payload?: any) {
  const raw = newToken();
  await db.user_tokens.insert({ token_hash: sha256(raw), user_id: userId, purpose, expires_at: addMinutes(minutes), used_at: null, payload: payload ? JSON.stringify(payload) : null });
  return raw;
}
/** Used by company routes to issue account-activation links. */
export const createAccountToken = createToken;
async function consumeToken(raw: string, purpose: string) {
  const t = await db.user_tokens.get({ token_hash: sha256(raw), purpose });
  if (!t || t.used_at || isExpired(t.expires_at)) throw bad('This link is invalid or has expired', 'bad_token');
  await db.user_tokens.set({ token_hash: t.token_hash }, { used_at: now() });
  return t;
}

/** Active memberships of a user in active companies, oldest membership first. */
async function activeMemberships(userId: string) {
  const ms = await db.company_members.list({ user_id: userId, status: 'active' }, { sort: { created_at: 1 } });
  const cos = ms.length ? await db.companies.list({ id: { $in: ms.map((m: any) => m.company_id) }, status: 'active' }) : [];
  const byId = new Map<string, any>(cos.map((c: any) => [c.id, c]));
  return ms.filter((m: any) => byId.has(m.company_id)).map((m: any) => ({ m, c: byId.get(m.company_id) }));
}

export async function userPayload(userId: string, companyId: string | null) {
  const u = await db.users.get({ id: userId });
  const memberships = (await activeMemberships(userId))
    .map(({ m, c }) => ({ company_id: c.id as string, company_name: c.name as string, role: m.role as string }))
    .sort((a, b) => (a.company_name < b.company_name ? -1 : a.company_name > b.company_name ? 1 : 0));
  const active = memberships.find(m => m.company_id === companyId) || null;
  const company = active ? await db.companies.get({ id: active.company_id }) : null;
  const role = active?.role ?? null;
  const permissions = role ? Object.keys(PERMS).filter(p => can(role as any, p as any)) : [];
  return {
    user: { id: u.id, email: u.email, name: u.name, isSuperAdmin: !!u.is_super_admin, emailVerified: !!u.email_verified, mfaEnabled: !!u.mfa_enabled },
    memberships, role, permissions,
    company: company ? { id: company.id, name: company.name, slug: company.slug, settings: j(company.settings, {}), logoUrl: logoUrl(company) } : null,
  };
}

/* ---------- company registration ---------- */
authRouter.post('/register', wrap(async (req, res) => {
  const b = parse(z.object({
    companyName: z.string().trim().min(2).max(100), name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email(), password,
  }), req.body);
  if (await db.users.exists({ email: b.email })) throw new HttpError(409, 'An account with this email already exists', 'email_taken');

  const userId = uid(), companyId = uid();
  let slug = slugify(b.companyName);
  if (await db.companies.exists({ slug })) slug += '-' + Math.random().toString(36).slice(2, 6);
  const plan = (await db.plans.get({ code: 'professional' })) ?? (await db.plans.get({}, { sort: { sort_order: 1 } }));
  const trialEnd = addDays(plan?.trial_days ?? 14);
  const defaultSettings = {
    aiEnabled: true, aiDataMinimization: true, secondaryCameraEnabled: true, recordingEnabled: true, recordingRetentionDays: 30,
    requireAdminMfa: false, timezone: 'Asia/Kolkata', hiringStages: ['Applied', 'Screening', 'Shortlisted', 'Interview Scheduled', 'Interview Completed', 'Evaluation', 'Selected', 'Rejected', 'On Hold'],
  };
  const pwHash = bcrypt.hashSync(b.password, 12);
  try {
    await tx(async () => {
      await db.users.insert({ id: userId, email: b.email, password_hash: pwHash, name: b.name, is_super_admin: 0, email_verified: 0, mfa_secret: null, mfa_enabled: 0, failed_logins: 0, locked_until: null, session_version: 0, created_at: now() });
      await db.companies.insert({ id: companyId, name: b.companyName, slug, website: null, industry: null, size: null, gst_number: null, billing_address: null, state: null, status: 'active', settings: JSON.stringify(defaultSettings), created_at: now() });
      await db.company_members.insert({ company_id: companyId, user_id: userId, role: 'owner', status: 'active', created_at: now() });
      if (plan) await db.subscriptions.insert({
        company_id: companyId, plan_id: plan.id, status: 'trialing', billing_cycle: 'monthly', trial_ends_at: trialEnd, current_period_start: now(), current_period_end: trialEnd,
        cancel_at_period_end: 0, custom_entitlements: null, coupon_code: null, gateway: null, gateway_ref: null, created_at: now(),
      });
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw new HttpError(409, 'An account with this email already exists', 'email_taken');
    throw e;
  }
  const raw = await createToken(userId, 'verify_email', 60 * 24 * 3);
  const link = `${config.appUrl}/verify-email?token=${raw}`;
  void sendMail(companyId, b.email, 'Verify your email', `Welcome to IntervueX, ${b.name}.\nConfirm your email: ${link}`);
  await seedStarterQuestions(companyId, userId);
  await audit(companyId, { userId, email: b.email }, 'company.registered', companyId, req);
  const user = await db.users.get({ id: userId });
  issueSession(res, user, companyId);
  res.status(201).json({ ...(await userPayload(userId, companyId)), ...(config.isProd ? {} : { devVerifyUrl: link }) });
}));

authRouter.post('/verify-email', wrap(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const t = await consumeToken(token, 'verify_email');
  await db.users.set({ id: t.user_id }, { email_verified: 1 });
  res.json({ ok: true });
}));

authRouter.post('/resend-verification', requireAuth, wrap(async (req, res) => {
  const raw = await createToken(req.auth!.userId, 'verify_email', 60 * 24 * 3);
  const link = `${config.appUrl}/verify-email?token=${raw}`;
  void sendMail(req.auth!.companyId, req.auth!.email, 'Verify your email', `Confirm your email: ${link}`);
  res.json({ ok: true, ...(config.isProd ? {} : { devVerifyUrl: link }) });
}));

/* ---------- login / logout ---------- */
authRouter.post('/login', wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1), totp: z.string().optional() }), req.body);
  const u = await db.users.get({ email: b.email });
  const fail = () => new HttpError(401, 'Incorrect email or password', 'bad_credentials');
  if (!u) { bcrypt.compareSync(b.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi'); throw fail(); }
  if (u.locked_until && !isExpired(u.locked_until)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.', 'locked');
  if (!bcrypt.compareSync(b.password, u.password_hash)) {
    const n = u.failed_logins + 1;
    await db.users.set({ id: u.id }, { failed_logins: n >= 5 ? 0 : n, locked_until: n >= 5 ? addMinutes(15) : null });
    await audit(null, { email: b.email }, 'auth.login_failed', u.id, req);
    throw fail();
  }
  if (u.mfa_enabled) {
    if (!b.totp) return res.status(200).json({ mfaRequired: true });
    if (!verifyTotp(u.mfa_secret, b.totp)) throw new HttpError(401, 'Invalid authentication code', 'bad_totp');
  }
  await db.users.set({ id: u.id }, { failed_logins: 0, locked_until: null });
  const first = (await activeMemberships(u.id))[0];
  const m = first ? { company_id: first.m.company_id as string, role: first.m.role as string } : undefined;
  // Admins in companies that require MFA must enrol.
  let mfaSetupRequired = false;
  if (m && ['owner', 'admin'].includes(m.role) && !u.mfa_enabled) {
    const c = await db.companies.get({ id: m.company_id });
    mfaSetupRequired = !!j<any>(c?.settings, {}).requireAdminMfa;
  }
  issueSession(res, u, m?.company_id ?? null);
  await audit(m?.company_id ?? null, { userId: u.id, email: u.email }, 'auth.login', u.id, req);
  res.json({ ...(await userPayload(u.id, m?.company_id ?? null)), mfaSetupRequired });
}));

authRouter.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

authRouter.get('/me', requireAuth, wrap(async (req, res) => { res.json(await userPayload(req.auth!.userId, req.auth!.companyId)); }));

authRouter.post('/switch-company', requireAuth, wrap(async (req, res) => {
  const { companyId } = parse(z.object({ companyId: z.string() }), req.body);
  const m = await db.company_members.exists({ company_id: companyId, user_id: req.auth!.userId, status: 'active' });
  if (!m) throw new HttpError(403, 'Not a member of that company');
  const u = await db.users.get({ id: req.auth!.userId });
  issueSession(res, u, companyId);
  res.json(await userPayload(u.id, companyId));
}));

/* ---------- password reset ---------- */
authRouter.post('/forgot-password', wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const u = await db.users.get({ email });
  let devUrl: string | undefined;
  if (u) {
    const raw = await createToken(u.id, 'reset_password', 60);
    devUrl = `${config.appUrl}/reset-password?token=${raw}`;
    void sendMail(null, email, 'Reset your password', `Reset your password (valid for 1 hour): ${devUrl}\nIf you didn't request this, ignore this email.`);
  }
  res.json({ ok: true, ...(config.isProd ? {} : { devResetUrl: devUrl }) }); // same response whether or not the account exists
}));

authRouter.post('/reset-password', wrap(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password }), req.body);
  const t = await consumeToken(b.token, 'reset_password');
  await db.users.update({ id: t.user_id }, { $set: { password_hash: bcrypt.hashSync(b.password, 12), failed_logins: 0, locked_until: null }, $inc: { session_version: 1 } });
  await audit(null, { userId: t.user_id }, 'auth.password_reset', t.user_id, req);
  res.json({ ok: true });
}));

/* ---------- account activation (accounts created by a company admin) ---------- */
authRouter.get('/activate/:token', wrap(async (req, res) => {
  const t = await db.user_tokens.get({ token_hash: sha256(String(req.params.token)), purpose: 'activate_account' });
  if (!t || t.used_at || isExpired(t.expires_at)) throw bad('This activation link is invalid or has expired. Ask your company admin to resend it.', 'bad_token');
  const u = await db.users.get({ id: t.user_id });
  const cid = j<any>(t.payload, {}).companyId;
  const co = cid ? await db.companies.get({ id: cid }) : null;
  const m = cid ? await db.company_members.get({ company_id: cid, user_id: t.user_id }) : null;
  res.json({ name: u?.name, email: u?.email, company: co?.name ?? null, role: m?.role ?? null });
}));
authRouter.post('/activate', wrap(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password }), req.body);
  const t = await consumeToken(b.token, 'activate_account');
  const u = await db.users.get({ id: t.user_id });
  if (!u) throw bad('This activation link is invalid', 'bad_token');
  if (u.password_hash) throw bad('This account is already active. Please sign in.', 'already_active');
  // Choosing a password through a link sent to the address also verifies the email.
  await db.users.update({ id: u.id }, { $set: { password_hash: bcrypt.hashSync(b.password, 12), email_verified: 1, failed_logins: 0, locked_until: null, activated_at: now() }, $inc: { session_version: 1 } });
  const fresh = await db.users.get({ id: u.id });
  const cid = j<any>(t.payload, {}).companyId;
  const mems = await activeMemberships(u.id);
  const companyId = cid && mems.some(x => x.m.company_id === cid) ? cid : (mems[0]?.m.company_id ?? null);
  issueSession(res, fresh, companyId);
  await audit(companyId, { userId: u.id, email: u.email }, 'auth.account_activated', u.id, req);
  res.json(await userPayload(u.id, companyId));
}));

authRouter.post('/change-password', requireAuth, wrap(async (req, res) => {
  const b = parse(z.object({ current: z.string(), password }), req.body);
  const u = await db.users.get({ id: req.auth!.userId });
  if (!bcrypt.compareSync(b.current, u.password_hash)) throw new HttpError(401, 'Current password is incorrect');
  await db.users.update({ id: u.id }, { $set: { password_hash: bcrypt.hashSync(b.password, 12) }, $inc: { session_version: 1 } });
  const fresh = await db.users.get({ id: u.id });
  issueSession(res, fresh, req.auth!.companyId);
  res.json({ ok: true });
}));

/* ---------- MFA (TOTP) ---------- */
authRouter.post('/mfa/setup', requireAuth, wrap(async (req, res) => {
  const secret = newTotpSecret();
  await db.users.set({ id: req.auth!.userId }, { mfa_secret: secret, mfa_enabled: 0 });
  const uri = `otpauth://totp/IntervueX:${encodeURIComponent(req.auth!.email)}?secret=${secret}&issuer=IntervueX`;
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri) });
}));
authRouter.post('/mfa/enable', requireAuth, wrap(async (req, res) => {
  const { code } = parse(z.object({ code: z.string().length(6) }), req.body);
  const u = await db.users.get({ id: req.auth!.userId });
  if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw new HttpError(400, 'Invalid code', 'bad_totp');
  await db.users.set({ id: req.auth!.userId }, { mfa_enabled: 1 });
  await audit(req.auth!.companyId, req.auth!, 'auth.mfa_enabled', req.auth!.userId, req);
  res.json({ ok: true });
}));
authRouter.post('/mfa/disable', requireAuth, wrap(async (req, res) => {
  const b = parse(z.object({ password: z.string(), code: z.string().length(6) }), req.body);
  const u = await db.users.get({ id: req.auth!.userId });
  if (!bcrypt.compareSync(b.password, u.password_hash) || !u.mfa_secret || !verifyTotp(u.mfa_secret, b.code)) throw new HttpError(401, 'Password or code incorrect');
  await db.users.set({ id: u.id }, { mfa_enabled: 0, mfa_secret: null });
  await audit(req.auth!.companyId, req.auth!, 'auth.mfa_disabled', u.id, req);
  res.json({ ok: true });
}));

/* ---------- accept team invitation ---------- */
authRouter.get('/invite/:token', wrap(async (req, res) => {
  const inv = await db.member_invites.get({ token_hash: sha256(String(req.params.token)) });
  const co = inv ? await db.companies.get({ id: inv.company_id }) : null;
  if (!inv || !co || inv.accepted_at || isExpired(inv.expires_at)) throw bad('This invitation is invalid or has expired', 'bad_token');
  const exists = await db.users.exists({ email: inv.email });
  res.json({ email: inv.email, role: inv.role, company: co.name, hasAccount: exists });
}));

authRouter.post('/invite/:token/accept', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(100).optional(), password: password.optional() }), req.body);
  const inv = await db.member_invites.get({ token_hash: sha256(String(req.params.token)) });
  if (!inv || inv.accepted_at || isExpired(inv.expires_at)) throw bad('This invitation is invalid or has expired', 'bad_token');
  let user = await db.users.get({ email: inv.email });
  await tx(async () => {
    if (!user) {
      if (!b.name || !b.password) throw bad('Name and password are required to create your account');
      const id = uid();
      // Accepting via emailed link proves ownership of the address.
      await db.users.insert({ id, email: inv.email, password_hash: bcrypt.hashSync(b.password, 12), name: b.name, is_super_admin: 0, email_verified: 1, mfa_secret: null, mfa_enabled: 0, failed_logins: 0, locked_until: null, session_version: 0, created_at: now() });
      user = await db.users.get({ id });
    } else if (!b.password || !bcrypt.compareSync(b.password, user.password_hash)) {
      throw new HttpError(401, 'Enter your existing password to join this company');
    }
    // Old INSERT OR REPLACE on UNIQUE(company_id,user_id): overwrite role/status/created_at of an existing membership.
    await db.company_members.upsert({ company_id: inv.company_id, user_id: user.id }, { role: inv.role, status: 'active', created_at: now() }, { id: uid() });
    await db.member_invites.set({ id: inv.id }, { accepted_at: now() });
  });
  issueSession(res, user, inv.company_id);
  await audit(inv.company_id, { userId: user.id, email: user.email }, 'member.joined', user.id, req);
  await notify(inv.company_id, inv.invited_by, 'member', `${user.name} joined your team`, `Role: ${inv.role}`, '/team');
  res.json(await userPayload(user.id, inv.company_id));
}));
