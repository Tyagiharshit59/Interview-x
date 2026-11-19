import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db, uid, now, j } from '../db.js';
import { config } from '../config.js';
import { COOKIE, issueSession, requireAuth, can } from '../auth.js';
import { wrap, parse, bad, HttpError, newToken, sha256, addMinutes, addDays, isExpired, slugify, newTotpSecret, verifyTotp } from '../util.js';
import { audit, sendMail, notify } from '../services.js';
import { PERMS } from '../auth.js';
import { seedStarterQuestions } from './coding.js';

export const authRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isProd ? 30 : 300, standardHeaders: true, legacyHeaders: false });
authRouter.use(limiter);

const password = z.string().min(8, 'At least 8 characters').max(128).regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');

function createToken(userId: string, purpose: string, minutes: number, payload?: any) {
  const raw = newToken();
  db.prepare('INSERT INTO user_tokens(token_hash,user_id,purpose,expires_at,payload) VALUES (?,?,?,?,?)').run(sha256(raw), userId, purpose, addMinutes(minutes), payload ? JSON.stringify(payload) : null);
  return raw;
}
function consumeToken(raw: string, purpose: string) {
  const t = db.prepare('SELECT * FROM user_tokens WHERE token_hash=? AND purpose=?').get(sha256(raw), purpose) as any;
  if (!t || t.used_at || isExpired(t.expires_at)) throw bad('This link is invalid or has expired', 'bad_token');
  db.prepare('UPDATE user_tokens SET used_at=? WHERE token_hash=?').run(now(), t.token_hash);
  return t;
}

export function userPayload(userId: string, companyId: string | null) {
  const u = db.prepare('SELECT id,email,name,is_super_admin,email_verified,mfa_enabled FROM users WHERE id=?').get(userId) as any;
  const memberships = db.prepare(`SELECT c.id company_id, c.name company_name, m.role FROM company_members m JOIN companies c ON c.id=m.company_id
    WHERE m.user_id=? AND m.status='active' AND c.status='active' ORDER BY c.name`).all(userId);
  const active = (memberships as any[]).find(m => m.company_id === companyId) || null;
  const company = active ? db.prepare('SELECT id,name,slug,settings FROM companies WHERE id=?').get(active.company_id) as any : null;
  const role = active?.role ?? null;
  const permissions = role ? Object.keys(PERMS).filter(p => can(role, p as any)) : [];
  return {
    user: { id: u.id, email: u.email, name: u.name, isSuperAdmin: !!u.is_super_admin, emailVerified: !!u.email_verified, mfaEnabled: !!u.mfa_enabled },
    memberships, role, permissions,
    company: company ? { id: company.id, name: company.name, slug: company.slug, settings: j(company.settings, {}) } : null,
  };
}

/* ---------- company registration ---------- */
authRouter.post('/register', wrap((req, res) => {
  const b = parse(z.object({
    companyName: z.string().trim().min(2).max(100), name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email(), password,
  }), req.body);
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(b.email)) throw new HttpError(409, 'An account with this email already exists', 'email_taken');

  const userId = uid(), companyId = uid();
  let slug = slugify(b.companyName);
  if (db.prepare('SELECT 1 FROM companies WHERE slug=?').get(slug)) slug += '-' + Math.random().toString(36).slice(2, 6);
  const plan = db.prepare("SELECT * FROM plans WHERE code='professional'").get() as any ?? db.prepare('SELECT * FROM plans ORDER BY sort_order LIMIT 1').get() as any;
  const trialEnd = addDays(plan?.trial_days ?? 14);
  const defaultSettings = {
    aiEnabled: true, aiDataMinimization: true, secondaryCameraEnabled: true, recordingEnabled: true, recordingRetentionDays: 30,
    requireAdminMfa: false, timezone: 'Asia/Kolkata', hiringStages: ['Applied', 'Screening', 'Shortlisted', 'Interview Scheduled', 'Interview Completed', 'Evaluation', 'Selected', 'Rejected', 'On Hold'],
  };
  db.transaction(() => {
    db.prepare('INSERT INTO users(id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)').run(userId, b.email, bcrypt.hashSync(b.password, 12), b.name, now());
    db.prepare('INSERT INTO companies(id,name,slug,settings,created_at) VALUES (?,?,?,?,?)').run(companyId, b.companyName, slug, JSON.stringify(defaultSettings), now());
    db.prepare("INSERT INTO company_members(id,company_id,user_id,role,created_at) VALUES (?,?,?,'owner',?)").run(uid(), companyId, userId, now());
    if (plan) db.prepare(`INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,trial_ends_at,current_period_start,current_period_end,created_at)
      VALUES (?,?,?,'trialing','monthly',?,?,?,?)`).run(uid(), companyId, plan.id, trialEnd, now(), trialEnd, now());
  })();
  const raw = createToken(userId, 'verify_email', 60 * 24 * 3);
  const link = `${config.appUrl}/verify-email?token=${raw}`;
  void sendMail(companyId, b.email, 'Verify your email', `Welcome to IntervueX, ${b.name}.\nConfirm your email: ${link}`);
  seedStarterQuestions(companyId, userId);
  audit(companyId, { userId, email: b.email }, 'company.registered', companyId, req);
  const user = db.prepare('SELECT id,session_version FROM users WHERE id=?').get(userId) as any;
  issueSession(res, user, companyId);
  res.status(201).json({ ...userPayload(userId, companyId), ...(config.isProd ? {} : { devVerifyUrl: link }) });
}));

authRouter.post('/verify-email', wrap((req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const t = consumeToken(token, 'verify_email');
  db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(t.user_id);
  res.json({ ok: true });
}));

authRouter.post('/resend-verification', requireAuth, wrap((req, res) => {
  const raw = createToken(req.auth!.userId, 'verify_email', 60 * 24 * 3);
  const link = `${config.appUrl}/verify-email?token=${raw}`;
  void sendMail(req.auth!.companyId, req.auth!.email, 'Verify your email', `Confirm your email: ${link}`);
  res.json({ ok: true, ...(config.isProd ? {} : { devVerifyUrl: link }) });
}));

/* ---------- login / logout ---------- */
authRouter.post('/login', wrap((req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1), totp: z.string().optional() }), req.body);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(b.email) as any;
  const fail = () => new HttpError(401, 'Incorrect email or password', 'bad_credentials');
  if (!u) { bcrypt.compareSync(b.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi'); throw fail(); }
  if (u.locked_until && !isExpired(u.locked_until)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.', 'locked');
  if (!bcrypt.compareSync(b.password, u.password_hash)) {
    const n = u.failed_logins + 1;
    db.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').run(n >= 5 ? 0 : n, n >= 5 ? addMinutes(15) : null, u.id);
    audit(null, { email: b.email }, 'auth.login_failed', u.id, req);
    throw fail();
  }
  if (u.mfa_enabled) {
    if (!b.totp) return res.status(200).json({ mfaRequired: true });
    if (!verifyTotp(u.mfa_secret, b.totp)) throw new HttpError(401, 'Invalid authentication code', 'bad_totp');
  }
  db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').run(u.id);
  const m = db.prepare(`SELECT m.company_id, m.role FROM company_members m JOIN companies c ON c.id=m.company_id WHERE m.user_id=? AND m.status='active' AND c.status='active' ORDER BY m.created_at LIMIT 1`).get(u.id) as any;
  // Admins in companies that require MFA must enrol.
  let mfaSetupRequired = false;
  if (m && ['owner', 'admin'].includes(m.role) && !u.mfa_enabled) {
    const c = db.prepare('SELECT settings FROM companies WHERE id=?').get(m.company_id) as any;
    mfaSetupRequired = !!j<any>(c.settings, {}).requireAdminMfa;
  }
  issueSession(res, u, m?.company_id ?? null);
  audit(m?.company_id ?? null, { userId: u.id, email: u.email }, 'auth.login', u.id, req);
  res.json({ ...userPayload(u.id, m?.company_id ?? null), mfaSetupRequired });
}));

authRouter.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

authRouter.get('/me', requireAuth, wrap((req, res) => { res.json(userPayload(req.auth!.userId, req.auth!.companyId)); }));

authRouter.post('/switch-company', requireAuth, wrap((req, res) => {
  const { companyId } = parse(z.object({ companyId: z.string() }), req.body);
  const m = db.prepare("SELECT 1 FROM company_members WHERE company_id=? AND user_id=? AND status='active'").get(companyId, req.auth!.userId);
  if (!m) throw new HttpError(403, 'Not a member of that company');
  const u = db.prepare('SELECT id,session_version FROM users WHERE id=?').get(req.auth!.userId) as any;
  issueSession(res, u, companyId);
  res.json(userPayload(u.id, companyId));
}));

/* ---------- password reset ---------- */
authRouter.post('/forgot-password', wrap((req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const u = db.prepare('SELECT id FROM users WHERE email=?').get(email) as any;
  let devUrl: string | undefined;
  if (u) {
    const raw = createToken(u.id, 'reset_password', 60);
    devUrl = `${config.appUrl}/reset-password?token=${raw}`;
    void sendMail(null, email, 'Reset your password', `Reset your password (valid for 1 hour): ${devUrl}\nIf you didn't request this, ignore this email.`);
  }
  res.json({ ok: true, ...(config.isProd ? {} : { devResetUrl: devUrl }) }); // same response whether or not the account exists
}));

authRouter.post('/reset-password', wrap((req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password }), req.body);
  const t = consumeToken(b.token, 'reset_password');
  db.prepare('UPDATE users SET password_hash=?, session_version=session_version+1, failed_logins=0, locked_until=NULL WHERE id=?').run(bcrypt.hashSync(b.password, 12), t.user_id);
  audit(null, { userId: t.user_id }, 'auth.password_reset', t.user_id, req);
  res.json({ ok: true });
}));

authRouter.post('/change-password', requireAuth, wrap((req, res) => {
  const b = parse(z.object({ current: z.string(), password }), req.body);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth!.userId) as any;
  if (!bcrypt.compareSync(b.current, u.password_hash)) throw new HttpError(401, 'Current password is incorrect');
  db.prepare('UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?').run(bcrypt.hashSync(b.password, 12), u.id);
  const fresh = db.prepare('SELECT id,session_version FROM users WHERE id=?').get(u.id) as any;
  issueSession(res, fresh, req.auth!.companyId);
  res.json({ ok: true });
}));

/* ---------- MFA (TOTP) ---------- */
authRouter.post('/mfa/setup', requireAuth, wrap(async (req, res) => {
  const secret = newTotpSecret();
  db.prepare('UPDATE users SET mfa_secret=?, mfa_enabled=0 WHERE id=?').run(secret, req.auth!.userId);
  const uri = `otpauth://totp/IntervueX:${encodeURIComponent(req.auth!.email)}?secret=${secret}&issuer=IntervueX`;
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri) });
}));
authRouter.post('/mfa/enable', requireAuth, wrap((req, res) => {
  const { code } = parse(z.object({ code: z.string().length(6) }), req.body);
  const u = db.prepare('SELECT mfa_secret FROM users WHERE id=?').get(req.auth!.userId) as any;
  if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw new HttpError(400, 'Invalid code', 'bad_totp');
  db.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').run(req.auth!.userId);
  audit(req.auth!.companyId, req.auth!, 'auth.mfa_enabled', req.auth!.userId, req);
  res.json({ ok: true });
}));
authRouter.post('/mfa/disable', requireAuth, wrap((req, res) => {
  const b = parse(z.object({ password: z.string(), code: z.string().length(6) }), req.body);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth!.userId) as any;
  if (!bcrypt.compareSync(b.password, u.password_hash) || !u.mfa_secret || !verifyTotp(u.mfa_secret, b.code)) throw new HttpError(401, 'Password or code incorrect');
  db.prepare('UPDATE users SET mfa_enabled=0, mfa_secret=NULL WHERE id=?').run(u.id);
  audit(req.auth!.companyId, req.auth!, 'auth.mfa_disabled', u.id, req);
  res.json({ ok: true });
}));

/* ---------- accept team invitation ---------- */
authRouter.get('/invite/:token', wrap((req, res) => {
  const inv = db.prepare(`SELECT i.email, i.role, i.expires_at, i.accepted_at, c.name company FROM member_invites i JOIN companies c ON c.id=i.company_id WHERE token_hash=?`).get(sha256(String(req.params.token))) as any;
  if (!inv || inv.accepted_at || isExpired(inv.expires_at)) throw bad('This invitation is invalid or has expired', 'bad_token');
  const exists = !!db.prepare('SELECT 1 FROM users WHERE email=?').get(inv.email);
  res.json({ email: inv.email, role: inv.role, company: inv.company, hasAccount: exists });
}));

authRouter.post('/invite/:token/accept', wrap((req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(100).optional(), password: password.optional() }), req.body);
  const inv = db.prepare('SELECT * FROM member_invites WHERE token_hash=?').get(sha256(String(req.params.token))) as any;
  if (!inv || inv.accepted_at || isExpired(inv.expires_at)) throw bad('This invitation is invalid or has expired', 'bad_token');
  let user = db.prepare('SELECT * FROM users WHERE email=?').get(inv.email) as any;
  db.transaction(() => {
    if (!user) {
      if (!b.name || !b.password) throw bad('Name and password are required to create your account');
      const id = uid();
      // Accepting via emailed link proves ownership of the address.
      db.prepare('INSERT INTO users(id,email,password_hash,name,email_verified,created_at) VALUES (?,?,?,?,1,?)').run(id, inv.email, bcrypt.hashSync(b.password, 12), b.name, now());
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    } else if (!b.password || !bcrypt.compareSync(b.password, user.password_hash)) {
      throw new HttpError(401, 'Enter your existing password to join this company');
    }
    db.prepare("INSERT OR REPLACE INTO company_members(id,company_id,user_id,role,status,created_at) VALUES (?,?,?,?, 'active', ?)").run(uid(), inv.company_id, user.id, inv.role, now());
    db.prepare('UPDATE member_invites SET accepted_at=? WHERE id=?').run(now(), inv.id);
  })();
  issueSession(res, user, inv.company_id);
  audit(inv.company_id, { userId: user.id, email: user.email }, 'member.joined', user.id, req);
  notify(inv.company_id, inv.invited_by, 'member', `${user.name} joined your team`, `Role: ${inv.role}`, '/team');
  res.json(userPayload(user.id, inv.company_id));
}));
