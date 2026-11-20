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

adminRouter.get('/stats', wrap(async (_req, res) => {
  const [companies, activeCompanies, users, interviews, paidSubscriptions, trialing, revenuePaise, openSupport] = await Promise.all([
    db.companies.count(), db.companies.count({ status: 'active' }), db.users.count({ is_super_admin: 0 }),
    db.interviews.count(), db.subscriptions.count({ status: 'active' }), db.subscriptions.count({ status: 'trialing' }),
    db.invoices.sum('total', { status: 'paid' }), db.support_requests.count({ status: 'open' }),
  ]);
  res.json({ companies, activeCompanies, users, interviews, paidSubscriptions, trialing, revenuePaise, openSupport });
}));

adminRouter.get('/health', wrap(async (_req, res) => {
  let dbOk = false; try { await db.plans.exists({}); dbOk = true; } catch { /* */ }
  res.json({ db: dbOk, uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), runner: runnerInfo(), ai: config.ai.baseUrl ? 'provider configured' : 'rule-based fallback', smtp: config.smtp ? 'configured' : 'dev log only', razorpay: config.razorpay.keyId ? 'configured' : 'not configured', node: process.version });
}));

adminRouter.get('/companies', wrap(async (_req, res) => {
  const cos = await db.companies.list({}, { sort: { created_at: -1 }, limit: 500 });
  const ids = cos.map(c => c.id);
  const [subs, memberCounts, interviewCounts] = await Promise.all([
    db.subscriptions.list({ company_id: { $in: ids } }),
    db.company_members.aggregate([{ $match: { company_id: { $in: ids }, status: 'active' } }, { $group: { _id: '$company_id', n: { $sum: 1 } } }]),
    db.interviews.aggregate([{ $match: { company_id: { $in: ids } } }, { $group: { _id: '$company_id', n: { $sum: 1 } } }]),
  ]);
  const plans = await db.plans.list({ id: { $in: [...new Set(subs.map(s => s.plan_id))] } });
  const subBy = new Map(subs.map(s => [s.company_id, s])); const planBy = new Map(plans.map(p => [p.id, p]));
  const mc = new Map(memberCounts.map(r => [r._id, r.n])); const ic = new Map(interviewCounts.map(r => [r._id, r.n]));
  const rows = cos.map(c => {
    const s = subBy.get(c.id);
    return { id: c.id, name: c.name, slug: c.slug, status: c.status, created_at: c.created_at, sub_status: s?.status ?? null, plan: (s && planBy.get(s.plan_id)?.name) ?? null,
      current_period_end: s?.current_period_end ?? null, trial_ends_at: s?.trial_ends_at ?? null, members: mc.get(c.id) ?? 0, interviews: ic.get(c.id) ?? 0 };
  });
  res.json({ items: rows });
}));

adminRouter.get('/companies/:id', wrap(async (req, res) => {
  const c = await db.companies.get({ id: String(req.params.id) });
  if (!c) throw notFound();
  const s = await db.subscriptions.get({ company_id: c.id });
  const mrows = await db.company_members.list({ company_id: c.id });
  const users = await db.users.list({ id: { $in: mrows.map(m => m.user_id) } });
  const userBy = new Map(users.map(u => [u.id, u]));
  const members = mrows.filter(m => userBy.has(m.user_id)).map(m => ({ name: userBy.get(m.user_id).name, email: userBy.get(m.user_id).email, role: m.role, status: m.status }));
  const invoices = await db.invoices.list({ company_id: c.id }, { sort: { issued_at: -1 }, projection: { number: 1, total: 1, status: 1, issued_at: 1 } });
  const support = await db.support_requests.list({ company_id: c.id }, { sort: { created_at: -1 }, projection: { subject: 1, status: 1, support_access_until: 1, created_at: 1 } });
  res.json({ company: { ...c, settings: j(c.settings, {}) }, subscription: s ? { ...s, custom_entitlements: j(s.custom_entitlements, {}) } : null, entitlements: await getEntitlements(c.id), usage: await usageSummary(c.id), members, invoices, support });
}));

adminRouter.patch('/companies/:id/status', wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
  const n = await db.companies.set({ id: String(req.params.id) }, { status });
  if (!n) throw notFound();
  await audit(String(req.params.id), req.auth!, `admin.company_${status}`, String(req.params.id), req);
  res.json({ ok: true });
}));

adminRouter.put('/companies/:id/subscription', wrap(async (req, res) => {
  const b = parse(z.object({
    planCode: z.string().optional(), status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']).optional(), extendDays: z.number().int().min(0).max(3650).optional(),
    customEntitlements: z.record(z.string(), z.union([z.number(), z.boolean()])).nullable().optional(),
  }), req.body);
  const cid = String(req.params.id);
  const s = await db.subscriptions.get({ company_id: cid });
  const plan = b.planCode ? await db.plans.get({ code: b.planCode }) : null;
  if (b.planCode && !plan) throw notFound('Plan not found');
  if (!s) {
    if (!plan) throw new HttpError(400, 'Choose a plan');
    await db.subscriptions.insert({ company_id: cid, plan_id: plan.id, status: b.status ?? 'active', billing_cycle: 'monthly', trial_ends_at: null, current_period_start: now(), current_period_end: addDays(b.extendDays ?? 30), cancel_at_period_end: 0, custom_entitlements: null, coupon_code: null, gateway: null, gateway_ref: null, created_at: now() });
  } else {
    const end = b.extendDays ? addDays(b.extendDays, new Date(Math.max(Date.now(), new Date(s.current_period_end).getTime()))) : s.current_period_end;
    const fields: Record<string, any> = {
      plan_id: plan?.id ?? s.plan_id, status: b.status ?? s.status, current_period_end: end,
      custom_entitlements: b.customEntitlements === undefined ? s.custom_entitlements : (b.customEntitlements ? JSON.stringify(b.customEntitlements) : null),
    };
    if (b.extendDays != null && s.status === 'trialing') fields.trial_ends_at = end;
    await db.subscriptions.set({ company_id: cid }, fields);
  }
  await audit(cid, req.auth!, 'admin.subscription_changed', cid, req, b);
  res.json({ ok: true });
}));

/* ---------- plans ---------- */
const planBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,30}$/), name: z.string().trim().min(2).max(60), description: z.string().max(300).nullish(),
  price_monthly: z.number().int().min(0), price_yearly: z.number().int().min(0), entitlements: z.record(z.string(), z.union([z.number(), z.boolean()])),
  overage: z.record(z.string(), z.number()).default({}), is_public: z.boolean().default(true), is_active: z.boolean().default(true), sort_order: z.number().int().default(0), trial_days: z.number().int().min(0).max(90).default(14),
});
adminRouter.get('/plans', wrap(async (_req, res) => res.json({ items: (await db.plans.list({}, { sort: { sort_order: 1 } })).map(p => ({ ...p, entitlements: j(p.entitlements, {}), overage: j(p.overage, {}) })), knownEntitlements: DEFAULT_ENTITLEMENTS })));
adminRouter.post('/plans', wrap(async (req, res) => {
  const b = parse(planBody, req.body);
  if (await db.plans.exists({ code: b.code })) throw new HttpError(409, 'Plan code already exists');
  await db.plans.insert({ code: b.code, name: b.name, description: b.description ?? null, price_monthly: b.price_monthly, price_yearly: b.price_yearly, currency: 'INR', entitlements: JSON.stringify(b.entitlements), overage: JSON.stringify(b.overage), is_public: +b.is_public, is_active: +b.is_active, sort_order: b.sort_order, trial_days: b.trial_days });
  await audit(null, req.auth!, 'admin.plan_created', b.code, req);
  res.status(201).json({ ok: true });
}));
adminRouter.put('/plans/:id', wrap(async (req, res) => {
  const b = parse(planBody, req.body);
  const n = await db.plans.set({ id: String(req.params.id) }, { code: b.code, name: b.name, description: b.description ?? null, price_monthly: b.price_monthly, price_yearly: b.price_yearly, entitlements: JSON.stringify(b.entitlements), overage: JSON.stringify(b.overage), is_public: +b.is_public, is_active: +b.is_active, sort_order: b.sort_order, trial_days: b.trial_days });
  if (!n) throw notFound();
  await audit(null, req.auth!, 'admin.plan_updated', b.code, req);
  res.json({ ok: true });
}));

/* ---------- coupons / flags / announcements ---------- */
adminRouter.get('/coupons', wrap(async (_req, res) => res.json({ items: await db.coupons.list({}, { sort: { code: 1 } }) })));
adminRouter.post('/coupons', wrap(async (req, res) => {
  const b = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/), percent_off: z.number().int().min(1).max(100), max_redemptions: z.number().int().min(1).nullish(), expires_at: z.string().datetime().nullish() }), req.body);
  // INSERT OR REPLACE semantics: an existing coupon with this code is reset (redeemed back to 0, active again)
  await db.coupons.upsert({ code: b.code }, { percent_off: b.percent_off, max_redemptions: b.max_redemptions ?? null, redeemed: 0, expires_at: b.expires_at ?? null, is_active: 1 });
  res.status(201).json({ ok: true });
}));
adminRouter.delete('/coupons/:code', wrap(async (req, res) => { await db.coupons.setMany({ code: String(req.params.code) }, { is_active: 0 }); res.json({ ok: true }); }));

adminRouter.get('/flags', wrap(async (_req, res) => res.json({ items: await db.feature_flags.list({}, { sort: { key: 1 } }) })));
adminRouter.put('/flags/:key', wrap(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean(), description: z.string().max(200).optional() }), req.body);
  // description is only overwritten when one is supplied (COALESCE semantics)
  await db.feature_flags.upsert({ key: String(req.params.key) }, b.description != null ? { enabled: +b.enabled, description: b.description } : { enabled: +b.enabled }, { description: null });
  await audit(null, req.auth!, 'admin.flag', `${req.params.key}=${b.enabled}`, req);
  res.json({ ok: true });
}));
adminRouter.get('/announcements', wrap(async (_req, res) => res.json({ items: await db.announcements.list({}, { sort: { created_at: -1 } }) })));
adminRouter.post('/announcements', wrap(async (req, res) => {
  const b = parse(z.object({ message: z.string().trim().min(3).max(300), level: z.enum(['info', 'warning', 'critical']).default('info') }), req.body);
  await db.announcements.insert({ message: b.message, level: b.level, active: 1, created_at: now() });
  res.status(201).json({ ok: true });
}));
adminRouter.delete('/announcements/:id', wrap(async (req, res) => { await db.announcements.set({ id: String(req.params.id) }, { active: 0 }); res.json({ ok: true }); }));

/* ---------- invoices, support, audit ---------- */
adminRouter.get('/invoices', wrap(async (_req, res) => {
  const invs = await db.invoices.list({}, { sort: { issued_at: -1 }, limit: 300, projection: { number: 1, total: 1, status: 1, issued_at: 1, paid_at: 1, company_id: 1 } });
  const cos = await db.companies.list({ id: { $in: [...new Set(invs.map(i => i.company_id))] } }, { projection: { name: 1 } });
  const nameBy = new Map(cos.map(c => [c.id, c.name]));
  res.json({ items: invs.filter(i => nameBy.has(i.company_id)).map(({ company_id, ...i }) => ({ ...i, company: nameBy.get(company_id) })) });
}));
adminRouter.get('/support', wrap(async (_req, res) => {
  const rows = await db.support_requests.list({}, { sort: { created_at: -1 }, limit: 200 });
  const cos = await db.companies.list({ id: { $in: [...new Set(rows.map(r => r.company_id))] } }, { projection: { name: 1 } });
  const us = await db.users.list({ id: { $in: [...new Set(rows.map(r => r.user_id))] } }, { projection: { email: 1 } });
  const nameBy = new Map(cos.map(c => [c.id, c.name])); const emailBy = new Map(us.map(u => [u.id, u.email]));
  res.json({ items: rows.filter(r => nameBy.has(r.company_id) && emailBy.has(r.user_id)).map(r => ({ ...r, company: nameBy.get(r.company_id), requester: emailBy.get(r.user_id) })) });
}));
adminRouter.patch('/support/:id', wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['open', 'in_progress', 'resolved']) }), req.body);
  await db.support_requests.set({ id: String(req.params.id) }, { status });
  res.json({ ok: true });
}));
adminRouter.get('/audit', wrap(async (_req, res) => res.json({ items: await db.audit_logs.list({}, { sort: { created_at: -1 }, limit: 300 }) })));

/** Support access works only while the customer has explicitly granted a time-boxed window; it is read-only and every request is audited. */
adminRouter.post('/companies/:id/support-session', wrap(async (req, res) => {
  const cid = String(req.params.id);
  const grant = await db.support_requests.get({ company_id: cid, support_access_until: { $gt: now() } }, { sort: { support_access_until: -1 } });
  if (!grant) throw new HttpError(403, 'The customer has not granted support access (or it has expired).', 'no_grant');
  const u = await db.users.get({ id: req.auth!.userId });
  issueSession(res, u, cid, true);
  await audit(cid, req.auth!, 'support.session_started', grant.id, req, { until: grant.support_access_until });
  res.json({ ok: true, until: grant.support_access_until });
}));
