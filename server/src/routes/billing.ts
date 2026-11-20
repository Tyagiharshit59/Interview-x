import { invoicePdf } from '../extras.js';
import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, uid, now, j, tx, isDuplicateKey, NOCASE } from '../db.js';
import { config } from '../config.js';
import { requirePerm, tenant } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound, timingSafeEq, addDays } from '../util.js';
import { audit, getSubscription, getEntitlements, usageSummary, notify } from '../services.js';

export const billingRouter = Router();
export const webhookRouter = Router();

const GST_RATE = 0.18;
/** All invoice money is stored in paise (integer) to avoid float rounding. Plan prices are whole rupees. */
function price(plan: any, cycle: 'monthly' | 'yearly', couponPct: number) {
  const base = (cycle === 'yearly' ? plan.price_yearly : plan.price_monthly) * 100;
  const discount = Math.round(base * couponPct / 100);
  const subtotal = base - discount;
  const company = null as any; void company;
  return { base, discount, subtotal };
}
function taxes(subtotal: number, companyState: string | null) {
  const intra = !companyState || companyState.trim().toLowerCase() === config.homeState.toLowerCase();
  const gst = Math.round(subtotal * GST_RATE);
  return intra ? { cgst: Math.round(gst / 2), sgst: gst - Math.round(gst / 2), igst: 0 } : { cgst: 0, sgst: 0, igst: gst };
}
async function validCoupon(code: string | undefined | null) {
  if (!code) return null;
  const c = await db.coupons.get({ code, is_active: 1 }, { collation: NOCASE });
  if (!c) throw new HttpError(404, 'Coupon not found', 'bad_coupon');
  if (c.expires_at && new Date(c.expires_at) < new Date()) throw bad('Coupon has expired', 'bad_coupon');
  if (c.max_redemptions != null && c.redeemed >= c.max_redemptions) throw bad('Coupon has been fully redeemed', 'bad_coupon');
  return c as { code: string; percent_off: number };
}
const nextInvoiceNumber = async () => {
  const y = new Date().getFullYear();
  const n = (await db.invoices.count({ number: { $regex: `^IVX/${y}/` } })) + 1;
  return `IVX/${y}/${String(n).padStart(5, '0')}`;
};

billingRouter.get('/billing', requirePerm('billing.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const s = await getSubscription(cid);
  const ent = await getEntitlements(cid);
  const invoices = await db.invoices.list({ company_id: cid }, { sort: { issued_at: -1 }, projection: { number: 1, description: 1, total: 1, currency: 1, status: 1, issued_at: 1, paid_at: 1 } });
  const plans = (await db.plans.list({ is_active: 1, is_public: 1 }, { sort: { sort_order: 1 } })).map(p => ({ ...p, entitlements: j(p.entitlements, {}), overage: j(p.overage, {}) }));
  res.json({
    subscription: s ? { plan: s.plan_name, planCode: s.plan_code, status: ent._status, billingCycle: s.billing_cycle, trialEndsAt: s.trial_ends_at, periodEnd: s.current_period_end, cancelAtPeriodEnd: !!s.cancel_at_period_end } : null,
    entitlements: ent, usage: await usageSummary(cid), invoices, plans,
    gateway: config.razorpay.keyId ? 'razorpay' : config.isProd ? 'none' : 'dev', keyId: config.razorpay.keyId || null,
  });
}));

billingRouter.post('/billing/coupon', requirePerm('billing.manage'), wrap(async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(2).max(40) }), req.body);
  const c = (await validCoupon(code))!;
  res.json({ code: c.code, percentOff: c.percent_off });
}));

billingRouter.post('/billing/checkout', requirePerm('billing.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const b = parse(z.object({ planCode: z.string(), cycle: z.enum(['monthly', 'yearly']), coupon: z.string().max(40).optional() }), req.body);
  const plan = await db.plans.get({ code: b.planCode, is_active: 1 });
  if (!plan) throw notFound('Plan not found');
  if (!plan.is_public) throw bad('This plan is only available through sales');
  const coupon = await validCoupon(b.coupon);
  const co = await db.companies.get({ id: cid });
  const p = price(plan, b.cycle, coupon?.percent_off ?? 0);
  const t = taxes(p.subtotal, co.state);
  const total = p.subtotal + t.cgst + t.sgst + t.igst;
  const id = uid();
  const snapshot = { name: co.name, gst_number: co.gst_number, address: co.billing_address, state: co.state };
  let gateway = 'dev', gatewayRef: string | null = `dev_${id}`, order: any = null;
  if (config.razorpay.keyId) {
    gateway = 'razorpay';
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64') },
      body: JSON.stringify({ amount: total, currency: 'INR', receipt: id.slice(0, 30), notes: { invoiceId: id, companyId: cid } }), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new HttpError(502, 'Payment gateway error. Please try again.', 'gateway_error');
    order = await r.json(); gatewayRef = order.id;
  } else if (config.isProd) throw new HttpError(503, 'Payments are not configured', 'no_gateway');
  const doc = {
    id, company_id: cid, description: `${plan.name} plan (${b.cycle})`, plan_id: plan.id, billing_cycle: b.cycle, subtotal: p.subtotal, discount: p.discount,
    cgst: t.cgst, sgst: t.sgst, igst: t.igst, total, currency: 'INR', status: 'pending', gateway, gateway_ref: gatewayRef, billing_snapshot: JSON.stringify(snapshot),
    coupon_code: coupon?.code ?? null, issued_at: now(), paid_at: null,
  };
  try { await db.invoices.insert({ ...doc, number: await nextInvoiceNumber() }); }
  catch (e) { if (!isDuplicateKey(e)) throw e; await db.invoices.insert({ ...doc, number: await nextInvoiceNumber() }); } // retry once if a concurrent checkout took the same number
  res.status(201).json({ invoiceId: id, gateway, total, orderId: order?.id ?? null, keyId: config.razorpay.keyId || null });
}));

/** Activates the subscription for a paid invoice. Idempotent: running twice has no extra effect. */
async function settleInvoice(invoiceId: string, gatewayPaymentId?: string) {
  const inv = await db.invoices.get({ id: invoiceId });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'paid') return inv;
  const activated = await tx(async () => {
    const changed = await db.invoices.update({ id: inv.id, status: { $ne: 'paid' } }, { $set: { status: 'paid', paid_at: now() } });
    if (!changed) return false; // settled concurrently: nothing more to do
    const days = inv.billing_cycle === 'yearly' ? 365 : 30;
    const ref = gatewayPaymentId ?? inv.gateway_ref;
    const sub = await db.subscriptions.get({ company_id: inv.company_id });
    if (sub) await db.subscriptions.set({ id: sub.id }, { plan_id: inv.plan_id, status: 'active', billing_cycle: inv.billing_cycle, trial_ends_at: null, current_period_start: now(), current_period_end: addDays(days), cancel_at_period_end: 0, coupon_code: inv.coupon_code, gateway: inv.gateway, gateway_ref: ref });
    else await db.subscriptions.insert({ company_id: inv.company_id, plan_id: inv.plan_id, status: 'active', billing_cycle: inv.billing_cycle, trial_ends_at: null, current_period_start: now(), current_period_end: addDays(days), cancel_at_period_end: 0, custom_entitlements: null, coupon_code: inv.coupon_code, gateway: inv.gateway, gateway_ref: ref, created_at: now() });
    if (inv.coupon_code) {
      const cp = await db.coupons.get({ code: inv.coupon_code }, { collation: NOCASE }); // codes were matched case-insensitively
      if (cp) await db.coupons.inc({ code: cp.code }, { redeemed: 1 });
    }
    return true;
  });
  if (!activated) return inv;
  for (const m of await db.company_members.list({ company_id: inv.company_id, role: { $in: ['owner', 'admin'] } }))
    await notify(inv.company_id, m.user_id, 'billing', 'Payment received', `${inv.description} — thank you.`, '/billing', { email: true });
  await audit(inv.company_id, null, 'billing.paid', inv.id);
  return inv;
}

/** Local development only: simulate a successful payment. Disabled in production and whenever Razorpay is configured. */
billingRouter.post('/billing/dev-pay/:invoiceId', requirePerm('billing.manage'), wrap(async (req, res) => {
  if (config.isProd || config.razorpay.keyId) throw new HttpError(404, 'Not found');
  const inv = await db.invoices.get({ id: String(req.params.invoiceId), company_id: tenant(req) });
  if (!inv) throw notFound();
  await settleInvoice(String(req.params.invoiceId));
  res.json({ ok: true });
}));

/** Browser-side Razorpay confirmation (signature verified server-side). The webhook is the source of truth; this just speeds up UX. */
billingRouter.post('/billing/razorpay/verify', requirePerm('billing.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${b.razorpay_order_id}|${b.razorpay_payment_id}`).digest('hex');
  if (!config.razorpay.keySecret || !timingSafeEq(expected, b.razorpay_signature)) throw new HttpError(400, 'Payment signature mismatch', 'bad_signature');
  const inv = await db.invoices.get({ gateway_ref: b.razorpay_order_id, company_id: tenant(req) });
  if (!inv) throw notFound();
  await settleInvoice(inv.id, b.razorpay_payment_id);
  res.json({ ok: true });
}));

/** Razorpay webhook: HMAC verified over the raw body, de-duplicated by event id so retries are safe. */
webhookRouter.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const raw = req.body as Buffer;
  const sig = String(req.headers['x-razorpay-signature'] || '');
  if (!config.razorpay.webhookSecret) throw new HttpError(503, 'Webhook secret not configured');
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(raw).digest('hex');
  if (!timingSafeEq(expected, sig)) throw new HttpError(400, 'Invalid signature');
  const eventId = String(req.headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(raw).digest('hex'));
  if (await db.webhook_events.exists({ id: eventId })) return res.json({ ok: true, duplicate: true });
  const ev = JSON.parse(raw.toString('utf8'));
  if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
    const orderId = ev.payload?.payment?.entity?.order_id || ev.payload?.order?.entity?.id;
    const inv = orderId ? await db.invoices.get({ gateway_ref: orderId }) : null;
    if (inv) await settleInvoice(inv.id, ev.payload?.payment?.entity?.id);
  } else if (ev.event === 'payment.failed') {
    const orderId = ev.payload?.payment?.entity?.order_id;
    if (orderId) await db.invoices.setMany({ gateway_ref: orderId, status: 'pending' }, { status: 'failed' });
  }
  try { await db.webhook_events.insert({ id: eventId, provider: 'razorpay', received_at: now() }); }
  catch (e) { if (isDuplicateKey(e)) return res.json({ ok: true, duplicate: true }); throw e; }
  res.json({ ok: true });
}));

billingRouter.post('/billing/cancel', requirePerm('billing.manage'), wrap(async (req, res) => {
  const s = await getSubscription(tenant(req));
  if (!s) throw notFound('No subscription');
  await db.subscriptions.set({ company_id: tenant(req) }, { cancel_at_period_end: 1 });
  await audit(tenant(req), req.auth!, 'billing.cancel_scheduled', s.id, req);
  res.json({ ok: true, accessUntil: s.current_period_end });
}));
billingRouter.post('/billing/resume', requirePerm('billing.manage'), wrap(async (req, res) => {
  await db.subscriptions.set({ company_id: tenant(req) }, { cancel_at_period_end: 0 });
  res.json({ ok: true });
}));

billingRouter.get('/invoices/:id', requirePerm('billing.manage'), wrap(async (req, res) => {
  const inv = await db.invoices.get({ id: String(req.params.id), company_id: tenant(req) });
  if (!inv) throw notFound();
  res.json({
    ...inv, billing_snapshot: j(inv.billing_snapshot, {}),
    seller: { name: 'IntervueX (placeholder legal entity)', gstin: process.env.SELLER_GSTIN || 'Set SELLER_GSTIN', state: config.homeState, sac: '998314' },
    note: 'Amounts in paise. Confirm invoice format, SAC code and e-invoicing applicability with your tax adviser.',
  });
}));

billingRouter.get('/invoices/:id/pdf', requirePerm('billing.manage'), wrap(async (req, res) => {
  const inv = await db.invoices.get({ id: String(req.params.id), company_id: tenant(req) });
  if (!inv) throw notFound();
  const pdf = await invoicePdf(inv);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${String(inv.number).replace(/[^A-Za-z0-9_-]/g, '-')}.pdf"`);
  res.send(pdf);
}));
