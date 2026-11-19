import { invoicePdf } from '../extras.js';
import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
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
function validCoupon(code: string | undefined | null) {
  if (!code) return null;
  const c = db.prepare('SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND is_active=1').get(code) as any;
  if (!c) throw new HttpError(404, 'Coupon not found', 'bad_coupon');
  if (c.expires_at && new Date(c.expires_at) < new Date()) throw bad('Coupon has expired', 'bad_coupon');
  if (c.max_redemptions != null && c.redeemed >= c.max_redemptions) throw bad('Coupon has been fully redeemed', 'bad_coupon');
  return c as { code: string; percent_off: number };
}
const nextInvoiceNumber = () => {
  const y = new Date().getFullYear();
  const n = (db.prepare("SELECT COUNT(*) c FROM invoices WHERE number LIKE ?").get(`IVX/${y}/%`) as any).c + 1;
  return `IVX/${y}/${String(n).padStart(5, '0')}`;
};

billingRouter.get('/billing', requirePerm('billing.manage'), wrap((req, res) => {
  const cid = tenant(req);
  const s = getSubscription(cid);
  const ent = getEntitlements(cid);
  const invoices = db.prepare('SELECT id,number,description,total,currency,status,issued_at,paid_at FROM invoices WHERE company_id=? ORDER BY issued_at DESC').all(cid);
  const plans = (db.prepare('SELECT * FROM plans WHERE is_active=1 AND is_public=1 ORDER BY sort_order').all() as any[]).map(p => ({ ...p, entitlements: j(p.entitlements, {}), overage: j(p.overage, {}) }));
  res.json({
    subscription: s ? { plan: s.plan_name, planCode: s.plan_code, status: ent._status, billingCycle: s.billing_cycle, trialEndsAt: s.trial_ends_at, periodEnd: s.current_period_end, cancelAtPeriodEnd: !!s.cancel_at_period_end } : null,
    entitlements: ent, usage: usageSummary(cid), invoices, plans,
    gateway: config.razorpay.keyId ? 'razorpay' : config.isProd ? 'none' : 'dev', keyId: config.razorpay.keyId || null,
  });
}));

billingRouter.post('/billing/coupon', requirePerm('billing.manage'), wrap((req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(2).max(40) }), req.body);
  const c = validCoupon(code)!;
  res.json({ code: c.code, percentOff: c.percent_off });
}));

billingRouter.post('/billing/checkout', requirePerm('billing.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const b = parse(z.object({ planCode: z.string(), cycle: z.enum(['monthly', 'yearly']), coupon: z.string().max(40).optional() }), req.body);
  const plan = db.prepare('SELECT * FROM plans WHERE code=? AND is_active=1').get(b.planCode) as any;
  if (!plan) throw notFound('Plan not found');
  if (!plan.is_public) throw bad('This plan is only available through sales');
  const coupon = validCoupon(b.coupon);
  const co = db.prepare('SELECT * FROM companies WHERE id=?').get(cid) as any;
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
  db.prepare(`INSERT INTO invoices(id,company_id,number,description,plan_id,billing_cycle,subtotal,discount,cgst,sgst,igst,total,currency,status,gateway,gateway_ref,billing_snapshot,coupon_code,issued_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'INR','pending',?,?,?,?,?)`)
    .run(id, cid, nextInvoiceNumber(), `${plan.name} plan (${b.cycle})`, plan.id, b.cycle, p.subtotal, p.discount, t.cgst, t.sgst, t.igst, total, gateway, gatewayRef, JSON.stringify(snapshot), coupon?.code ?? null, now());
  res.status(201).json({ invoiceId: id, gateway, total, orderId: order?.id ?? null, keyId: config.razorpay.keyId || null });
}));

/** Activates the subscription for a paid invoice. Idempotent: running twice has no extra effect. */
function settleInvoice(invoiceId: string, gatewayPaymentId?: string) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId) as any;
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'paid') return inv;
  db.transaction(() => {
    db.prepare("UPDATE invoices SET status='paid', paid_at=? WHERE id=? AND status!='paid'").run(now(), inv.id);
    const days = inv.billing_cycle === 'yearly' ? 365 : 30;
    const sub = db.prepare('SELECT id FROM subscriptions WHERE company_id=?').get(inv.company_id) as any;
    if (sub) db.prepare("UPDATE subscriptions SET plan_id=?, status='active', billing_cycle=?, trial_ends_at=NULL, current_period_start=?, current_period_end=?, cancel_at_period_end=0, coupon_code=?, gateway=?, gateway_ref=? WHERE id=?")
      .run(inv.plan_id, inv.billing_cycle, now(), addDays(days), inv.coupon_code, inv.gateway, gatewayPaymentId ?? inv.gateway_ref, sub.id);
    else db.prepare("INSERT INTO subscriptions(id,company_id,plan_id,status,billing_cycle,current_period_start,current_period_end,coupon_code,gateway,gateway_ref,created_at) VALUES (?,?,?,'active',?,?,?,?,?,?,?)")
      .run(uid(), inv.company_id, inv.plan_id, inv.billing_cycle, now(), addDays(days), inv.coupon_code, inv.gateway, gatewayPaymentId ?? inv.gateway_ref, now());
    if (inv.coupon_code) db.prepare('UPDATE coupons SET redeemed=redeemed+1 WHERE code=? COLLATE NOCASE').run(inv.coupon_code);
  })();
  for (const m of db.prepare("SELECT user_id FROM company_members WHERE company_id=? AND role IN ('owner','admin')").all(inv.company_id) as any[])
    notify(inv.company_id, m.user_id, 'billing', 'Payment received', `${inv.description} — thank you.`, '/billing', { email: true });
  audit(inv.company_id, null, 'billing.paid', inv.id);
  return inv;
}

/** Local development only: simulate a successful payment. Disabled in production and whenever Razorpay is configured. */
billingRouter.post('/billing/dev-pay/:invoiceId', requirePerm('billing.manage'), wrap((req, res) => {
  if (config.isProd || config.razorpay.keyId) throw new HttpError(404, 'Not found');
  const inv = db.prepare('SELECT id FROM invoices WHERE id=? AND company_id=?').get(req.params.invoiceId, tenant(req));
  if (!inv) throw notFound();
  settleInvoice(String(req.params.invoiceId));
  res.json({ ok: true });
}));

/** Browser-side Razorpay confirmation (signature verified server-side). The webhook is the source of truth; this just speeds up UX. */
billingRouter.post('/billing/razorpay/verify', requirePerm('billing.manage'), wrap((req, res) => {
  const b = parse(z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${b.razorpay_order_id}|${b.razorpay_payment_id}`).digest('hex');
  if (!config.razorpay.keySecret || !timingSafeEq(expected, b.razorpay_signature)) throw new HttpError(400, 'Payment signature mismatch', 'bad_signature');
  const inv = db.prepare('SELECT id FROM invoices WHERE gateway_ref=? AND company_id=?').get(b.razorpay_order_id, tenant(req)) as any;
  if (!inv) throw notFound();
  settleInvoice(inv.id, b.razorpay_payment_id);
  res.json({ ok: true });
}));

/** Razorpay webhook: HMAC verified over the raw body, de-duplicated by event id so retries are safe. */
webhookRouter.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), wrap((req, res) => {
  const raw = req.body as Buffer;
  const sig = String(req.headers['x-razorpay-signature'] || '');
  if (!config.razorpay.webhookSecret) throw new HttpError(503, 'Webhook secret not configured');
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(raw).digest('hex');
  if (!timingSafeEq(expected, sig)) throw new HttpError(400, 'Invalid signature');
  const eventId = String(req.headers['x-razorpay-event-id'] || crypto.createHash('sha256').update(raw).digest('hex'));
  if (db.prepare('SELECT 1 FROM webhook_events WHERE id=?').get(eventId)) return res.json({ ok: true, duplicate: true });
  const ev = JSON.parse(raw.toString('utf8'));
  if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
    const orderId = ev.payload?.payment?.entity?.order_id || ev.payload?.order?.entity?.id;
    const inv = orderId ? db.prepare('SELECT id FROM invoices WHERE gateway_ref=?').get(orderId) as any : null;
    if (inv) settleInvoice(inv.id, ev.payload?.payment?.entity?.id);
  } else if (ev.event === 'payment.failed') {
    const orderId = ev.payload?.payment?.entity?.order_id;
    db.prepare("UPDATE invoices SET status='failed' WHERE gateway_ref=? AND status='pending'").run(orderId);
  }
  db.prepare('INSERT INTO webhook_events(id,provider,received_at) VALUES (?,?,?)').run(eventId, 'razorpay', now());
  res.json({ ok: true });
}));

billingRouter.post('/billing/cancel', requirePerm('billing.manage'), wrap((req, res) => {
  const s = getSubscription(tenant(req));
  if (!s) throw notFound('No subscription');
  db.prepare('UPDATE subscriptions SET cancel_at_period_end=1 WHERE company_id=?').run(tenant(req));
  audit(tenant(req), req.auth!, 'billing.cancel_scheduled', s.id, req);
  res.json({ ok: true, accessUntil: s.current_period_end });
}));
billingRouter.post('/billing/resume', requirePerm('billing.manage'), wrap((req, res) => {
  db.prepare('UPDATE subscriptions SET cancel_at_period_end=0 WHERE company_id=?').run(tenant(req));
  res.json({ ok: true });
}));

billingRouter.get('/invoices/:id', requirePerm('billing.manage'), wrap((req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=?').get(req.params.id, tenant(req)) as any;
  if (!inv) throw notFound();
  res.json({
    ...inv, billing_snapshot: j(inv.billing_snapshot, {}),
    seller: { name: 'IntervueX (placeholder legal entity)', gstin: process.env.SELLER_GSTIN || 'Set SELLER_GSTIN', state: config.homeState, sac: '998314' },
    note: 'Amounts in paise. Confirm invoice format, SAC code and e-invoicing applicability with your tax adviser.',
  });
}));

billingRouter.get('/invoices/:id/pdf', requirePerm('billing.manage'), wrap(async (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND company_id=?').get(req.params.id, tenant(req)) as any;
  if (!inv) throw notFound();
  const pdf = await invoicePdf(inv);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${String(inv.number).replace(/[^A-Za-z0-9_-]/g, '-')}.pdf"`);
  res.send(pdf);
}));
