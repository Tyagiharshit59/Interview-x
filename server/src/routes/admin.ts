import { Router } from 'express';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
import { requireSuperAdmin, issueSession } from '../auth.js';
import { wrap, parse, HttpError, notFound, addDays } from '../util.js';
import { audit, usageSummary, getEntitlements, DEFAULT_ENTITLEMENTS } from '../services.js';
import { runnerInfo } from '../code.js';
import { config } from '../config.js';

export const adminRouter = Router();
adminRouter.use(requireSuperAdmin);

adminRouter.get('/stats', wrap((_req, res) => {
  const c = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).c;
  res.json({
    companies: c('SELECT COUNT(*) c FROM companies'), activeCompanies: c("SELECT COUNT(*) c FROM companies WHERE status='active'"), users: c('SELECT COUNT(*) c FROM users WHERE is_super_admin=0'),
    interviews: c('SELECT COUNT(*) c FROM interviews'), paidSubscriptions: c("SELECT COUNT(*) c FROM subscriptions WHERE status='active'"), trialing: c("SELECT COUNT(*) c FROM subscriptions WHERE status='trialing'"),
    revenuePaise: c("SELECT COALESCE(SUM(total),0) c FROM invoices WHERE status='paid'"), openSupport: c("SELECT COUNT(*) c FROM support_requests WHERE status='open'"),
  });
}));

adminRouter.get('/health', wrap((_req, res) => {
  let dbOk = false; try { db.prepare('SELECT 1').get(); dbOk = true; } catch { /* */ }
  res.json({ db: dbOk, uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), runner: runnerInfo(), ai: config.ai.baseUrl ? 'provider configured' : 'rule-based fallback', smtp: config.smtp ? 'configured' : 'dev log only', razorpay: config.razorpay.keyId ? 'configured' : 'not configured', node: process.version });
}));

adminRouter.get('/companies', wrap((_req, res) => {
  const rows = db.prepare(`SELECT c.id,c.name,c.slug,c.status,c.created_at, s.status sub_status, p.name plan, s.current_period_end, s.trial_ends_at,
    (SELECT COUNT(*) FROM company_members m WHERE m.company_id=c.id AND m.status='active') members,
    (SELECT COUNT(*) FROM interviews i WHERE i.company_id=c.id) interviews
    FROM companies c LEFT JOIN subscriptions s ON s.company_id=c.id LEFT JOIN plans p ON p.id=s.plan_id ORDER BY c.created_at DESC LIMIT 500`).all();
  res.json({ items: rows });
}));

adminRouter.get('/companies/:id', wrap((req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id) as any;
  if (!c) throw notFound();
  const s = db.prepare('SELECT * FROM subscriptions WHERE company_id=?').get(c.id) as any;
  const members = db.prepare('SELECT u.name,u.email,m.role,m.status FROM company_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=?').all(c.id);
  const invoices = db.prepare('SELECT id,number,total,status,issued_at FROM invoices WHERE company_id=? ORDER BY issued_at DESC').all(c.id);
  const support = db.prepare('SELECT id,subject,status,support_access_until,created_at FROM support_requests WHERE company_id=? ORDER BY created_at DESC').all(c.id);
  res.json({ company: { ...c, settings: j(c.settings, {}) }, subscription: s ? { ...s, custom_entitlements: j(s.custom_entitlements, {}) } : null, entitlements: getEntitlements(c.id), usage: usageSummary(c.id), members, invoices, support });
}));

adminRouter.patch('/companies/:id/status', wrap((req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
  const r = db.prepare('UPDATE companies SET status=? WHERE id=?').run(status, req.params.id);
  if (!r.changes) throw notFound();
  audit(String(req.params.id), req.auth!, `admin.company_${status}`, String(req.params.id), req);
  res.json({ ok: true });
}));

adminRouter.put('/companies/:id/subscription', wrap((req, res) => {
  const b = parse(z.object({
    planCode: z.string().optional(), status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']).optional(), extendDays: z.number().int().min(0).max(3650).optional(),
    customEntitlements: z.record(z.string(), z.union([z.number(), z.boolean()])).nullable().optional(),
  }), req.body);
  const cid = String(req.params.id);
  const s = db.prepare('SELECT * FROM subscriptions WHERE company_id=?').get(cid) as any;
  const plan = b.planCode ? db.prepare('SELECT * FROM plans WHERE code=?').get(b.planCode) as any : null;
  if (b.planCode && !plan) throw notFound('Plan not found');
  if (!s) {
    if (!plan) throw new HttpError(400, 'Choose a plan');
    db.prepare("INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,current_period_start,current_period_end,created_at) VALUES (?,?,?,?,?,?,?,?)").run(uid(), cid, plan.id, b.status ?? 'active', 'monthly', now(), addDays(b.extendDays ?? 30), now());
  } else {
    const end = b.extendDays ? addDays(b.extendDays, new Date(Math.max(Date.now(), new Date(s.current_period_end).getTime()))) : s.current_period_end;
    db.prepare('UPDATE subscriptions SET plan_id=?, status=?, current_period_end=?, trial_ends_at=CASE WHEN ? IS NOT NULL AND status=? THEN ? ELSE trial_ends_at END, custom_entitlements=? WHERE company_id=?')
      .run(plan?.id ?? s.plan_id, b.status ?? s.status, end, b.extendDays ?? null, 'trialing', end, b.customEntitlements === undefined ? s.custom_entitlements : (b.customEntitlements ? JSON.stringify(b.customEntitlements) : null), cid);
  }
  audit(cid, req.auth!, 'admin.subscription_changed', cid, req, b);
  res.json({ ok: true });
}));

/* ---------- plans ---------- */
const planBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,30}$/), name: z.string().trim().min(2).max(60), description: z.string().max(300).nullish(),
  price_monthly: z.number().int().min(0), price_yearly: z.number().int().min(0), entitlements: z.record(z.string(), z.union([z.number(), z.boolean()])),
  overage: z.record(z.string(), z.number()).default({}), is_public: z.boolean().default(true), is_active: z.boolean().default(true), sort_order: z.number().int().default(0), trial_days: z.number().int().min(0).max(90).default(14),
});
adminRouter.get('/plans', wrap((_req, res) => res.json({ items: (db.prepare('SELECT * FROM plans ORDER BY sort_order').all() as any[]).map(p => ({ ...p, entitlements: j(p.entitlements, {}), overage: j(p.overage, {}) })), knownEntitlements: DEFAULT_ENTITLEMENTS })));
adminRouter.post('/plans', wrap((req, res) => {
  const b = parse(planBody, req.body);
  if (db.prepare('SELECT 1 FROM plans WHERE code=?').get(b.code)) throw new HttpError(409, 'Plan code already exists');
  db.prepare('INSERT INTO plans(id,code,name,description,price_monthly,price_yearly,entitlements,overage,is_public,is_active,sort_order,trial_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(uid(), b.code, b.name, b.description ?? null, b.price_monthly, b.price_yearly, JSON.stringify(b.entitlements), JSON.stringify(b.overage), +b.is_public, +b.is_active, b.sort_order, b.trial_days);
  audit(null, req.auth!, 'admin.plan_created', b.code, req);
  res.status(201).json({ ok: true });
}));
adminRouter.put('/plans/:id', wrap((req, res) => {
  const b = parse(planBody, req.body);
  const r = db.prepare('UPDATE plans SET code=?,name=?,description=?,price_monthly=?,price_yearly=?,entitlements=?,overage=?,is_public=?,is_active=?,sort_order=?,trial_days=? WHERE id=?')
    .run(b.code, b.name, b.description ?? null, b.price_monthly, b.price_yearly, JSON.stringify(b.entitlements), JSON.stringify(b.overage), +b.is_public, +b.is_active, b.sort_order, b.trial_days, req.params.id);
  if (!r.changes) throw notFound();
  audit(null, req.auth!, 'admin.plan_updated', b.code, req);
  res.json({ ok: true });
}));

/* ---------- coupons / flags / announcements ---------- */
adminRouter.get('/coupons', wrap((_req, res) => res.json({ items: db.prepare('SELECT * FROM coupons ORDER BY code').all() })));
adminRouter.post('/coupons', wrap((req, res) => {
  const b = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/), percent_off: z.number().int().min(1).max(100), max_redemptions: z.number().int().min(1).nullish(), expires_at: z.string().datetime().nullish() }), req.body);
  db.prepare('INSERT OR REPLACE INTO coupons(code,percent_off,max_redemptions,expires_at,is_active) VALUES (?,?,?,?,1)').run(b.code, b.percent_off, b.max_redemptions ?? null, b.expires_at ?? null);
  res.status(201).json({ ok: true });
}));
adminRouter.delete('/coupons/:code', wrap((req, res) => { db.prepare('UPDATE coupons SET is_active=0 WHERE code=?').run(req.params.code); res.json({ ok: true }); }));

adminRouter.get('/flags', wrap((_req, res) => res.json({ items: db.prepare('SELECT * FROM feature_flags ORDER BY key').all() })));
adminRouter.put('/flags/:key', wrap((req, res) => {
  const b = parse(z.object({ enabled: z.boolean(), description: z.string().max(200).optional() }), req.body);
  db.prepare('INSERT INTO feature_flags(key,enabled,description) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled, description=COALESCE(excluded.description, feature_flags.description)').run(req.params.key, +b.enabled, b.description ?? null);
  audit(null, req.auth!, 'admin.flag', `${req.params.key}=${b.enabled}`, req);
  res.json({ ok: true });
}));
adminRouter.get('/announcements', wrap((_req, res) => res.json({ items: db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all() })));
adminRouter.post('/announcements', wrap((req, res) => {
  const b = parse(z.object({ message: z.string().trim().min(3).max(300), level: z.enum(['info', 'warning', 'critical']).default('info') }), req.body);
  db.prepare('INSERT INTO announcements(id,message,level,created_at) VALUES (?,?,?,?)').run(uid(), b.message, b.level, now());
  res.status(201).json({ ok: true });
}));
adminRouter.delete('/announcements/:id', wrap((req, res) => { db.prepare('UPDATE announcements SET active=0 WHERE id=?').run(req.params.id); res.json({ ok: true }); }));

/* ---------- invoices, support, audit ---------- */
adminRouter.get('/invoices', wrap((_req, res) => res.json({ items: db.prepare('SELECT i.id,i.number,i.total,i.status,i.issued_at,i.paid_at,c.name company FROM invoices i JOIN companies c ON c.id=i.company_id ORDER BY i.issued_at DESC LIMIT 300').all() })));
adminRouter.get('/support', wrap((_req, res) => res.json({ items: db.prepare('SELECT s.*, c.name company, u.email requester FROM support_requests s JOIN companies c ON c.id=s.company_id JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 200').all() })));
adminRouter.patch('/support/:id', wrap((req, res) => {
  const { status } = parse(z.object({ status: z.enum(['open', 'in_progress', 'resolved']) }), req.body);
  db.prepare('UPDATE support_requests SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
}));
adminRouter.get('/audit', wrap((_req, res) => res.json({ items: db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 300').all() })));

/** Support access works only while the customer has explicitly granted a time-boxed window; it is read-only and every request is audited. */
adminRouter.post('/companies/:id/support-session', wrap((req, res) => {
  const cid = String(req.params.id);
  const grant = db.prepare('SELECT id, support_access_until FROM support_requests WHERE company_id=? AND support_access_until>? ORDER BY support_access_until DESC LIMIT 1').get(cid, now()) as any;
  if (!grant) throw new HttpError(403, 'The customer has not granted support access (or it has expired).', 'no_grant');
  const u = db.prepare('SELECT id,session_version FROM users WHERE id=?').get(req.auth!.userId) as any;
  issueSession(res, u, cid, true);
  audit(cid, req.auth!, 'support.session_started', grant.id, req, { until: grant.support_access_until });
  res.json({ ok: true, until: grant.support_access_until });
}));
