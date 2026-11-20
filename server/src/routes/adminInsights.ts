/**
 * Platform console analytics and company management (super admin only; mounted inside adminRouter).
 * All numbers come from the database; nothing is estimated. Money: invoices are paise, plan prices are whole rupees.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db, tx, isDuplicateKey, uid, now, j } from '../db.js';
import { wrap, parse, HttpError, notFound, addDays, slugify } from '../util.js';
import { audit, sendMail, usageSummary, getEntitlements } from '../services.js';
import { config } from '../config.js';
import { createAccountToken } from './auth.js';
import { seedStarterQuestions } from './coding.js';
import { derivePrefix, PREFIX_RE } from '../jobcodes.js';

export const insightsRouter = Router();

/* ---------------- time helpers ---------------- */
const monthKey = (d: Date) => d.toISOString().slice(0, 7);
function lastMonths(n: number) { const out: string[] = []; const d = new Date(); d.setUTCDate(1); for (let i = n - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(monthKey(x)); } return out; }
const weekStart = (iso: string | Date) => { const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10); };
function lastWeeks(n: number) { const out: string[] = []; const cur = new Date(weekStart(new Date())); for (let i = n - 1; i >= 0; i--) out.push(new Date(cur.getTime() - i * 7 * 864e5).toISOString().slice(0, 10)); return out; }
const bucket = (rows: any[], field: string, keys: string[], keyOf: (v: string) => string, weight?: (r: any) => number) => {
  const m = new Map(keys.map(k => [k, 0]));
  for (const r of rows) { const v = r[field]; if (!v) continue; const k = keyOf(v); if (m.has(k)) m.set(k, m.get(k)! + (weight ? weight(r) : 1)); }
  return keys.map(k => ({ x: k, y: Math.round(m.get(k)! * 100) / 100 }));
};
const DAY = 864e5;
const isoAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/* ---------------- money ---------------- */
async function planMap() { return new Map((await db.plans.list()).map(p => [p.id, p])); }
/** Monthly recurring revenue in rupees for a paid subscription: custom price if negotiated, yearly prices spread over 12 months, discounts applied. Trials count 0. */
function mrrOf(s: any, plan: any) {
  if (!s || !plan || s.status !== 'active') return 0;
  const monthly = s.billing_cycle === 'yearly' ? (s.custom_price_yearly ?? plan.price_yearly) / 12 : (s.custom_price_monthly ?? plan.price_monthly);
  return Math.round(monthly * (1 - (Number(s.discount_percent) || 0) / 100));
}

/* ---------------- health ---------------- */
function healthOf(c: any, s: any, usage: { interviews: number; limit: number | null }, lastActivity: string | null) {
  if (c.status !== 'active') return { key: 'suspended', label: 'Suspended' };
  if (!s) return { key: 'no_plan', label: 'No plan' };
  if (['past_due', 'expired', 'cancelled'].includes(s.status) || (s.status === 'active' && new Date(s.current_period_end).getTime() < Date.now())) return { key: 'billing', label: 'Billing issue' };
  if (s.status === 'trialing' && s.trial_ends_at && new Date(s.trial_ends_at).getTime() - Date.now() < 7 * DAY) return { key: 'trial_ending', label: 'Trial ending' };
  if (usage.limit && usage.limit > 0 && usage.interviews >= usage.limit * 0.8) return { key: 'near_limit', label: 'Near limit' };
  if (!lastActivity || new Date(lastActivity).getTime() < Date.now() - 14 * DAY) return { key: 'inactive', label: 'Inactive 14d+' };
  return { key: 'healthy', label: 'Healthy' };
}

/** Everything the list and the overview need about every company, computed in a handful of bulk queries. */
async function companyFacts() {
  const cos = await db.companies.list({}, { sort: { created_at: -1 } });
  const ids = cos.map(c => c.id);
  const since56 = isoAgo(56), since45 = isoAgo(45), since30 = isoAgo(30);
  const [subs, plans, members, jobs, cands, ivTotals, recentIvs, lastAct, usage] = await Promise.all([
    db.subscriptions.list({ company_id: { $in: ids } }), planMap(),
    db.company_members.aggregate([{ $match: { company_id: { $in: ids }, status: 'active' } }, { $group: { _id: { c: '$company_id', emp: { $eq: ['$role', 'employee'] } }, n: { $sum: 1 } } }]),
    db.jobs.aggregate([{ $match: { company_id: { $in: ids }, is_template: { $ne: 1 } } }, { $group: { _id: { c: '$company_id', s: '$status' }, n: { $sum: 1 } } }]),
    db.candidates.aggregate([{ $match: { company_id: { $in: ids } } }, { $group: { _id: '$company_id', n: { $sum: 1 } } }]),
    db.interviews.aggregate([{ $match: { company_id: { $in: ids } } }, { $group: { _id: '$company_id', n: { $sum: 1 } } }]),
    db.interviews.list({ company_id: { $in: ids }, created_at: { $gte: since56 } }, { projection: { company_id: 1, created_at: 1 } }),
    db.audit_logs.aggregate([{ $match: { company_id: { $in: ids }, actor_id: { $ne: null } } }, { $group: { _id: '$company_id', t: { $max: '$created_at' } } }]),
    db.usage_records.list({ company_id: { $in: ids }, metric: 'interviews', created_at: { $gte: since45 } }, { projection: { company_id: 1, quantity: 1, created_at: 1 } }),
  ]);
  const subBy = new Map(subs.map(s => [s.company_id, s]));
  const memBy = new Map<string, { team: number; employees: number }>();
  for (const m of members) { const e = memBy.get(m._id.c) || { team: 0, employees: 0 }; if (m._id.emp) e.employees += m.n; else e.team += m.n; memBy.set(m._id.c, e); }
  const jobBy = new Map<string, { open: number; total: number }>();
  for (const r of jobs) { const e = jobBy.get(r._id.c) || { open: 0, total: 0 }; e.total += r.n; if (r._id.s === 'published') e.open += r.n; jobBy.set(r._id.c, e); }
  const candBy = new Map(cands.map(r => [r._id, r.n])); const ivBy = new Map(ivTotals.map(r => [r._id, r.n])); const actBy = new Map(lastAct.map(r => [r._id, r.t]));
  const weeks = lastWeeks(8);
  return cos.map(c => {
    const s = subBy.get(c.id); const plan = s ? plans.get(s.plan_id) : null;
    const ent = { ...j<any>(plan?.entitlements, {}), ...j<any>(s?.custom_entitlements, {}) };
    const periodStart = s?.current_period_start || since30;
    const usedIv = usage.filter(u => u.company_id === c.id && u.created_at >= periodStart).reduce((a, u) => a + (u.quantity || 0), 0);
    const limit = typeof ent.interviews_per_month === 'number' ? ent.interviews_per_month : null;
    const ivRecent = recentIvs.filter(i => i.company_id === c.id);
    const last = actBy.get(c.id) ?? null;
    return {
      c, s, plan, ent,
      row: {
        id: c.id, name: c.name, slug: c.slug, status: c.status, created_at: c.created_at, industry: c.industry ?? null, country: c.country ?? null, tags: c.admin_tags ?? [],
        plan: plan?.name ?? null, plan_code: plan?.code ?? null, sub_status: s?.status ?? null, trial_ends_at: s?.trial_ends_at ?? null, current_period_end: s?.current_period_end ?? null,
        team: memBy.get(c.id)?.team ?? 0, employees: memBy.get(c.id)?.employees ?? 0, jobs_open: jobBy.get(c.id)?.open ?? 0, jobs_total: jobBy.get(c.id)?.total ?? 0,
        candidates: candBy.get(c.id) ?? 0, interviews: ivBy.get(c.id) ?? 0, interviews_30d: ivRecent.filter(i => i.created_at >= since30).length,
        usage: { interviews: usedIv, limit }, mrr: mrrOf(s, plan), last_activity: last,
        trend: bucket(ivRecent, 'created_at', weeks, weekStart).map(p => p.y),
        health: healthOf(c, s, { interviews: usedIv, limit }, last),
      },
    };
  });
}

/* ======================= overview ======================= */
insightsRouter.get('/overview', wrap(async (_req, res) => {
  const facts = await companyFacts();
  const months = lastMonths(12); const from = months[0] + '-01';
  const [newCos, ivs, apps, paid, users, candAccounts, openSupport, referrals] = await Promise.all([
    db.companies.list({ created_at: { $gte: from } }, { projection: { created_at: 1 } }),
    db.interviews.list({ created_at: { $gte: from } }, { projection: { created_at: 1 } }),
    db.applications.list({ created_at: { $gte: from } }, { projection: { created_at: 1 } }),
    db.invoices.list({ status: 'paid' }, { projection: { total: 1, paid_at: 1, issued_at: 1 } }),
    db.users.count({ is_super_admin: { $ne: 1 } }), db.candidate_accounts.count(), db.support_requests.count({ status: 'open' }), db.referrals.count(),
  ]);
  const rows = facts.map(f => f.row);
  const mrr = rows.reduce((a, r) => a + r.mrr, 0);
  const planMix = new Map<string, number>();
  for (const r of rows) if (r.status === 'active' && r.sub_status && ['active', 'trialing'].includes(r.sub_status)) planMix.set(r.plan ?? 'No plan', (planMix.get(r.plan ?? 'No plan') ?? 0) + 1);
  const healthCount = new Map<string, number>(); for (const r of rows) healthCount.set(r.health.key, (healthCount.get(r.health.key) ?? 0) + 1);
  const revenueMonthly = bucket(paid.map(p => ({ ...p, at: p.paid_at || p.issued_at })), 'at', months, v => v.slice(0, 7), r => (r.total || 0) / 100);
  res.json({
    kpis: {
      companies: rows.length, active: rows.filter(r => r.status === 'active').length, suspended: rows.filter(r => r.status !== 'active').length,
      trialing: rows.filter(r => r.sub_status === 'trialing').length, paying: rows.filter(r => r.mrr > 0).length,
      mrr, arr: mrr * 12, revenue_total: Math.round(paid.reduce((a, p) => a + (p.total || 0), 0) / 100), revenue_30d: Math.round(paid.filter(p => (p.paid_at || p.issued_at) >= isoAgo(30)).reduce((a, p) => a + (p.total || 0), 0) / 100),
      users, candidate_accounts: candAccounts, interviews_30d: rows.reduce((a, r) => a + r.interviews_30d, 0), interviews_total: rows.reduce((a, r) => a + r.interviews, 0),
      jobs_open: rows.reduce((a, r) => a + r.jobs_open, 0), candidates: rows.reduce((a, r) => a + r.candidates, 0), open_support: openSupport, referrals,
    },
    series: {
      new_companies: bucket(newCos, 'created_at', months, v => v.slice(0, 7)),
      interviews: bucket(ivs, 'created_at', months, v => v.slice(0, 7)),
      applications: bucket(apps, 'created_at', months, v => v.slice(0, 7)),
      revenue: revenueMonthly,
    },
    plan_mix: [...planMix.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    health: [...healthCount.entries()].map(([key, value]) => ({ key, label: rows.find(r => r.health.key === key)!.health.label, value })),
    top_companies: [...rows].sort((a, b) => b.interviews_30d - a.interviews_30d || b.candidates - a.candidates).slice(0, 8).map(r => ({ id: r.id, name: r.name, interviews_30d: r.interviews_30d, candidates: r.candidates, plan: r.plan })),
    attention: rows.filter(r => r.health.key !== 'healthy').sort((a, b) => ['billing', 'trial_ending', 'near_limit', 'suspended', 'inactive', 'no_plan'].indexOf(a.health.key) - ['billing', 'trial_ending', 'near_limit', 'suspended', 'inactive', 'no_plan'].indexOf(b.health.key)).slice(0, 12)
      .map(r => ({ id: r.id, name: r.name, health: r.health, plan: r.plan, trial_ends_at: r.trial_ends_at, current_period_end: r.current_period_end, usage: r.usage, last_activity: r.last_activity })),
  });
}));

/* ======================= companies list ======================= */
insightsRouter.get('/companies-table', wrap(async (req, res) => {
  const { q, status, plan, health, sort = 'created', dir = 'desc' } = req.query as Record<string, string | undefined>;
  let rows = (await companyFacts()).map(f => f.row);
  if (q) { const s = q.toLowerCase(); rows = rows.filter(r => `${r.name} ${r.slug} ${r.industry ?? ''} ${r.country ?? ''} ${(r.tags || []).join(' ')}`.toLowerCase().includes(s)); }
  if (status) rows = rows.filter(r => (status === 'active' ? r.status === 'active' : r.status !== 'active'));
  if (plan) rows = rows.filter(r => (r.plan_code ?? '') === plan);
  if (health) rows = rows.filter(r => r.health.key === health);
  const key: Record<string, (r: any) => any> = { created: r => r.created_at, name: r => r.name.toLowerCase(), mrr: r => r.mrr, interviews: r => r.interviews_30d, candidates: r => r.candidates, activity: r => r.last_activity || '', team: r => r.team };
  const k = key[sort] || key.created; const m = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => (k(a) > k(b) ? m : k(a) < k(b) ? -m : 0));
  const plans = (await db.plans.list({}, { sort: { sort_order: 1 } })).map(p => ({ code: p.code, name: p.name }));
  res.json({ items: rows, plans, weeks: lastWeeks(8) });
}));

insightsRouter.get('/companies-export.csv', wrap(async (_req, res) => {
  const rows = (await companyFacts()).map(f => f.row);
  const esc = (v: any) => { const s = v == null ? '' : String(v); const t = /^[=+\-@]/.test(s) ? `'${s}` : s; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ['Company', 'Slug', 'Status', 'Health', 'Plan', 'Subscription', 'Trial ends', 'Period ends', 'MRR (INR)', 'Team', 'Employees', 'Open jobs', 'Candidates', 'Interviews (30d)', 'Interviews (total)', 'Last activity', 'Created', 'Tags'];
  const lines = [head.join(','), ...rows.map(r => [r.name, r.slug, r.status, r.health.label, r.plan, r.sub_status, r.trial_ends_at, r.current_period_end, r.mrr, r.team, r.employees, r.jobs_open, r.candidates, r.interviews_30d, r.interviews, r.last_activity, r.created_at, (r.tags || []).join('; ')].map(esc).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="intervuex-companies-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

/* ======================= one company, in depth ======================= */
insightsRouter.get('/companies/:id/insights', wrap(async (req, res) => {
  const cid = String(req.params.id);
  const c = await db.companies.get({ id: cid }); if (!c) throw notFound('Company not found');
  const s = await db.subscriptions.get({ company_id: cid }); const plan = s ? await db.plans.get({ id: s.plan_id }) : null;
  const weeks = lastWeeks(12); const from = weeks[0];
  const [members, jobs, cands, apps, ivs, invoices, auditRows, referrals, portalJoined, usageRows] = await Promise.all([
    db.company_members.list({ company_id: cid }), db.jobs.list({ company_id: cid, is_template: { $ne: 1 } }, { projection: { status: 1, title: 1, job_code: 1, created_at: 1 } }),
    db.candidates.list({ company_id: cid }, { projection: { created_at: 1, source: 1, email: 1, account_id: 1 } }),
    db.applications.list({ company_id: cid }, { projection: { stage: 1, created_at: 1, source: 1 } }),
    db.interviews.list({ company_id: cid }, { projection: { status: 1, created_at: 1, scheduled_at: 1, type: 1 } }),
    db.invoices.list({ company_id: cid }, { sort: { issued_at: -1 }, projection: { number: 1, total: 1, status: 1, issued_at: 1, paid_at: 1, description: 1 } }),
    db.audit_logs.list({ company_id: cid }, { sort: { created_at: -1 }, limit: 40 }),
    db.referrals.count({ company_id: cid }), db.candidates.count({ company_id: cid, account_id: { $ne: null } }),
    db.usage_records.list({ company_id: cid, created_at: { $gte: from } }, { projection: { metric: 1, quantity: 1, created_at: 1 } }),
  ]);
  const users = members.length ? await db.users.list({ id: { $in: members.map(m => m.user_id) } }) : [];
  const userBy = new Map(users.map(u => [u.id, u]));
  const countBy = (rows: any[], f: (r: any) => string) => { const m = new Map<string, number>(); for (const r of rows) { const k = f(r) || 'unknown'; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); };
  const stages = j<any>(c.settings, {}).hiringStages || [];
  const stageCounts = countBy(apps, a => a.stage);
  const funnel = [...stages.map((st: string) => ({ label: st, value: stageCounts.find(x => x.label === st)?.value ?? 0 })), ...stageCounts.filter(x => !stages.includes(x.label))];
  const last = auditRows.find(a => a.actor_id)?.created_at ?? null;
  const usage = (await usageSummary(cid)) as any;
  const ent = await getEntitlements(cid);
  res.json({
    company: { ...c, settings: j(c.settings, {}), admin_notes: c.admin_notes ?? [], admin_tags: c.admin_tags ?? [] },
    subscription: s ? { ...s, custom_entitlements: j(s.custom_entitlements, {}), plan_name: plan?.name, plan_code: plan?.code, plan_price_monthly: plan?.price_monthly, plan_price_yearly: plan?.price_yearly } : null,
    entitlements: ent, usage, mrr: mrrOf(s, plan),
    health: healthOf(c, s, { interviews: usage.interviews?.used ?? 0, limit: usage.interviews?.limit ?? null }, last), last_activity: last,
    counts: {
      team: members.filter(m => m.role !== 'employee' && m.status === 'active').length, employees: members.filter(m => m.role === 'employee' && m.status === 'active').length,
      jobs_open: jobs.filter(x => x.status === 'published').length, jobs_total: jobs.length, candidates: cands.length, applications: apps.length, interviews: ivs.length,
      interviews_completed: ivs.filter(i => i.status === 'completed').length, referrals, portal_joined: portalJoined,
      revenue_paid: Math.round(invoices.filter(i => i.status === 'paid').reduce((a, i) => a + (i.total || 0), 0) / 100),
    },
    series: {
      weeks,
      interviews: bucket(ivs, 'created_at', weeks, weekStart), applications: bucket(apps, 'created_at', weeks, weekStart), candidates: bucket(cands, 'created_at', weeks, weekStart),
      code_runs: bucket(usageRows.filter(u => u.metric === 'code_runs'), 'created_at', weeks, weekStart, r => r.quantity || 0),
      ai_calls: bucket(usageRows.filter(u => u.metric === 'ai_calls'), 'created_at', weeks, weekStart, r => r.quantity || 0),
    },
    breakdowns: {
      funnel, roles: countBy(members.filter(m => m.status === 'active'), m => m.role), sources: countBy(cands, x => x.source || 'manual'),
      interview_status: countBy(ivs, i => i.status), jobs_status: countBy(jobs, x => x.status),
    },
    members: members.map(m => { const u = userBy.get(m.user_id); return { id: m.id, name: u?.name ?? '—', email: u?.email ?? '—', role: m.role, status: m.status, pending_activation: u ? !u.password_hash : false, created_at: m.created_at }; })
      .sort((a, b) => a.name.localeCompare(b.name)),
    invoices, audit: auditRows.map(a => ({ id: a.id, action: a.action, actor: a.actor_label || 'system', target: a.target, created_at: a.created_at })),
  });
}));

/** Edit company profile, internal tags and plan-independent settings. */
insightsRouter.patch('/companies/:id', wrap(async (req, res) => {
  const cid = String(req.params.id);
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100), website: z.string().trim().max(200).nullable(), industry: z.string().trim().max(80).nullable(), size: z.string().trim().max(40).nullable(),
    email: z.string().trim().max(200).nullable(), contact_person: z.string().trim().max(100).nullable(), contact_phone: z.string().trim().max(30).nullable(),
    country: z.string().trim().max(60).nullable(), state: z.string().trim().max(60).nullable(), address: z.string().trim().max(400).nullable(), gst_number: z.string().trim().max(20).nullable(),
    admin_tags: z.array(z.string().trim().min(1).max(30)).max(12), jobCodePrefix: z.string().trim().toUpperCase().regex(PREFIX_RE),
  }).partial(), req.body);
  const c = await db.companies.get({ id: cid }); if (!c) throw notFound('Company not found');
  const { jobCodePrefix, ...fields } = b as any;
  const upd: any = { ...fields };
  for (const k of Object.keys(upd)) if (upd[k] === '') upd[k] = null;
  if (jobCodePrefix) upd.settings = JSON.stringify({ ...j<any>(c.settings, {}), jobCodePrefix });
  await db.companies.set({ id: cid }, upd);
  await audit(cid, req.auth!, 'admin.company_updated', cid, req, Object.keys(b));
  res.json({ ok: true });
}));

/** Internal notes about a customer (visible to IntervueX staff only). */
insightsRouter.post('/companies/:id/notes', wrap(async (req, res) => {
  const cid = String(req.params.id);
  const { text } = parse(z.object({ text: z.string().trim().min(2).max(2000) }), req.body);
  const n = await db.companies.update({ id: cid }, { $push: { admin_notes: { $each: [{ id: uid(), text, by: req.auth!.name, at: now() }], $position: 0, $slice: 200 } } } as any);
  if (!n) throw notFound('Company not found');
  await audit(cid, req.auth!, 'admin.company_note', cid, req);
  res.status(201).json({ ok: true });
}));

/** Commercial terms on top of the plan: negotiated price and discount. */
insightsRouter.put('/companies/:id/commercials', wrap(async (req, res) => {
  const cid = String(req.params.id);
  const b = parse(z.object({ custom_price_monthly: z.number().int().min(0).nullable(), custom_price_yearly: z.number().int().min(0).nullable(), discount_percent: z.number().int().min(0).max(100), billing_cycle: z.enum(['monthly', 'yearly']), notes: z.string().trim().max(500).nullable() }).partial(), req.body);
  const n = await db.subscriptions.set({ company_id: cid }, b);
  if (!n) throw notFound('This company has no subscription yet. Assign a plan first.');
  await audit(cid, req.auth!, 'admin.commercials_changed', cid, req, b);
  res.json({ ok: true });
}));

/** Provision a company and its owner from the console. The owner sets their own password through a single-use activation link. */
insightsRouter.post('/companies', wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100), industry: z.string().trim().max(80).optional().nullable(), website: z.string().trim().max(200).optional().nullable(), country: z.string().trim().max(60).optional().nullable(),
    owner_name: z.string().trim().min(2).max(100), owner_email: z.string().trim().toLowerCase().email(), owner_phone: z.string().trim().max(30).optional().nullable(),
    plan_code: z.string(), trial_days: z.number().int().min(0).max(365).default(14), jobCodePrefix: z.string().trim().toUpperCase().regex(PREFIX_RE).optional(),
  }), req.body);
  const plan = await db.plans.get({ code: b.plan_code }); if (!plan) throw notFound('Plan not found');
  const existingUser = await db.users.get({ email: b.owner_email });
  let slug = slugify(b.name); if (await db.companies.exists({ slug })) slug += '-' + Math.random().toString(36).slice(2, 6);
  const companyId = uid(); const userId = existingUser?.id ?? uid();
  const settings = { aiEnabled: true, aiDataMinimization: true, secondaryCameraEnabled: true, recordingEnabled: true, recordingRetentionDays: 30, requireAdminMfa: false, timezone: 'Asia/Kolkata',
    hiringStages: ['Applied', 'Screening', 'Shortlisted', 'Interview Scheduled', 'Interview Completed', 'Evaluation', 'Selected', 'Rejected', 'On Hold'], jobCodePrefix: b.jobCodePrefix || derivePrefix(b.name) };
  const trial = b.trial_days > 0; const end = addDays(trial ? b.trial_days : 30);
  try {
    await tx(async () => {
      if (!existingUser) await db.users.insert({ id: userId, email: b.owner_email, password_hash: '', name: b.owner_name, phone: b.owner_phone || null, is_super_admin: 0, email_verified: 0, mfa_secret: null, mfa_enabled: 0, failed_logins: 0, locked_until: null, session_version: 0, created_by: req.auth!.userId, created_at: now() });
      await db.companies.insert({ id: companyId, name: b.name, slug, website: b.website || null, industry: b.industry || null, size: null, gst_number: null, billing_address: null, state: null, country: b.country || null,
        email: b.owner_email, contact_person: b.owner_name, contact_phone: b.owner_phone || null, status: 'active', settings: JSON.stringify(settings), created_by: req.auth!.userId, job_seq: 0, created_at: now() });
      await db.company_members.insert({ company_id: companyId, user_id: userId, role: 'owner', status: 'active', created_at: now() });
      await db.subscriptions.insert({ company_id: companyId, plan_id: plan.id, status: trial ? 'trialing' : 'active', billing_cycle: 'monthly', trial_ends_at: trial ? end : null, current_period_start: now(), current_period_end: end,
        cancel_at_period_end: 0, custom_entitlements: null, coupon_code: null, gateway: null, gateway_ref: null, created_at: now() });
    });
  } catch (e) { if (isDuplicateKey(e)) throw new HttpError(409, 'A company or user with these details already exists', 'duplicate'); throw e; }
  await seedStarterQuestions(companyId, userId);
  let devActivateUrl: string | undefined;
  if (!existingUser || !existingUser.password_hash) {
    const raw = await createAccountToken(userId, 'activate_account', 60 * 24 * 7, { companyId });
    devActivateUrl = `${config.appUrl}/activate?token=${raw}`;
    void sendMail(companyId, b.owner_email, `Your IntervueX workspace for ${b.name} is ready`, `Hi ${b.owner_name},\n\nThe IntervueX team created a workspace for ${b.name} (${plan.name} plan${trial ? `, ${b.trial_days}-day trial` : ''}). Set your password to activate your owner account (link valid for 7 days, single use):\n${devActivateUrl}`);
  } else {
    void sendMail(companyId, b.owner_email, `You now own the ${b.name} workspace on IntervueX`, `Hi ${existingUser.name},\n\nThe IntervueX team created a workspace for ${b.name} and made you its owner. Sign in with your existing account: ${config.appUrl}/login`);
  }
  await audit(companyId, req.auth!, 'admin.company_created', companyId, req, { plan: plan.code, owner: b.owner_email, trialDays: b.trial_days });
  res.status(201).json({ ok: true, id: companyId, newOwnerAccount: !existingUser, ...(config.isProd ? {} : { devActivateUrl }) });
}));
