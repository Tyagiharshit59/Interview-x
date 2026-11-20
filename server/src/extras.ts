import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { db, now, j } from './db.js';
import { config } from './config.js';
import { getEntitlements, getSubscription, usageTotal, notify, periodStart, hooks } from './services.js';

/* ---------------- calendar (.ics) ---------------- */
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const fold = (line: string) => line.match(/.{1,70}/g)!.join('\r\n ');

/** Builds an RFC 5545 event. METHOD:REQUEST updates the same event on reschedule because UID and SEQUENCE are stable per interview. */
export function buildIcs(o: { interviewId: string; title: string; start: string; durationMin: number; description: string; method: 'REQUEST' | 'CANCEL'; sequence: number }) {
  const start = new Date(o.start); const end = new Date(start.getTime() + o.durationMin * 60000);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IntervueX//Interview//EN', 'CALSCALE:GREGORIAN', `METHOD:${o.method}`,
    'BEGIN:VEVENT', `UID:${o.interviewId}@intervuex`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SEQUENCE:${o.sequence}`, `SUMMARY:${icsEsc(o.title)}`, `DESCRIPTION:${icsEsc(o.description)}`, `STATUS:${o.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/* ---------------- PDF invoice ---------------- */
const rs = (paise: number) => `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function invoicePdf(inv: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const b = j<any>(inv.billing_snapshot, {});
    doc.fontSize(20).text('Tax invoice', { continued: false });
    doc.fontSize(10).fillColor('#555').text(`${inv.number}   |   Status: ${inv.status}`).fillColor('#000').moveDown();
    doc.fontSize(10).text('From', { underline: true });
    doc.text('IntervueX (placeholder legal entity)');
    doc.text(`GSTIN: ${process.env.SELLER_GSTIN || 'Set SELLER_GSTIN'}`).text(`State: ${config.homeState}`).text('SAC: 998314').moveDown();
    doc.text('Billed to', { underline: true });
    doc.text(b.name || '-'); if (b.address) doc.text(b.address);
    doc.text(`State: ${b.state || '-'}`).text(`GSTIN: ${b.gst_number || 'Unregistered'}`).moveDown();
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 50, y, { width: 350 }).text(value, 400, y, { width: 145, align: 'right' });
    };
    row(inv.description, rs(inv.subtotal + inv.discount));
    if (inv.discount > 0) row(`Discount${inv.coupon_code ? ` (${inv.coupon_code})` : ''}`, `-${rs(inv.discount)}`);
    row('Taxable value', rs(inv.subtotal));
    if (inv.cgst > 0) { row('CGST @ 9%', rs(inv.cgst)); row('SGST @ 9%', rs(inv.sgst)); }
    if (inv.igst > 0) row('IGST @ 18%', rs(inv.igst));
    doc.moveDown(0.5); row('Total', rs(inv.total), true);
    doc.font('Helvetica').moveDown(2).fontSize(8).fillColor('#555')
      .text(`Issued ${inv.issued_at}${inv.paid_at ? `  |  Paid ${inv.paid_at}` : ''}. Confirm invoice format, SAC code and e-invoicing applicability with your tax adviser. Not an e-invoice (no IRN).`);
    doc.end();
  });
}

/* ---------------- usage-limit warnings ---------------- */
const METRIC_LIMITS: Record<string, { key: string; label: string }> = {
  interviews: { key: 'interviews_per_month', label: 'interviews' }, code_runs: { key: 'code_runs_per_month', label: 'code runs' },
  ai_calls: { key: 'ai_calls_per_month', label: 'AI calls' }, recording_mb: { key: 'recording_storage_mb', label: 'recording storage (MB)' },
};
async function once(cid: string, action: string, target: string) {
  if (await db.audit_logs.exists({ company_id: cid, action, target })) return false;
  await db.audit_logs.insert({ company_id: cid, action, target, created_at: now() });
  return true;
}
const admins = (cid: string) => db.company_members.list({ company_id: cid, role: { $in: ['owner', 'admin'] }, status: 'active' });

/** Emails owners/admins once per billing period when a metric crosses 80% and again at 100%. Never throws. */
export async function checkUsageWarnings(cid: string, metric: string) {
  try {
    const m = METRIC_LIMITS[metric]; if (!m) return;
    const limit = ((await getEntitlements(cid)) as any)[m.key] as number;
    if (!limit || limit <= 0) return;
    const used = await usageTotal(cid, metric);
    const level = used >= limit ? 100 : used >= limit * 0.8 ? 80 : 0;
    if (!level) return;
    if (!(await once(cid, 'usage_warning', `${metric}:${level}:${await periodStart(cid)}`))) return;
    for (const a of await admins(cid)) await notify(cid, a.user_id, 'billing', level === 100 ? `You have reached your ${m.label} limit` : `You have used 80% of your ${m.label}`,
      `${Math.round(used)} of ${limit} ${m.label} used this billing period. ${level === 100 ? 'New usage is blocked until you upgrade or the period renews.' : 'Consider upgrading before you hit the limit.'}`, '/billing', { email: true });
  } catch (e) { console.error('[usage-warning]', e); }
}

/* ---------------- renewal & payment notices ---------------- */
/** Called by the background job. Notices are sent once per billing period. No automatic charging happens: renewal is a new payment. */
export async function subscriptionNotices() {
  for (const s of await db.subscriptions.list({ status: 'active' })) {
    const sub = await getSubscription(s.company_id); if (!sub) continue;
    const end = new Date(sub.current_period_end).getTime(); const days = (end - Date.now()) / 864e5;
    const stage = days < -3 ? 'overdue' : days < 0 ? 'expired' : days <= 7 ? 'renewal' : null;
    if (!stage || sub.cancel_at_period_end && stage === 'renewal') continue;
    if (!(await once(s.company_id, 'billing_notice', `${stage}:${sub.current_period_end}`))) continue;
    const text = { renewal: ['Your subscription renews soon', `Your plan period ends ${new Date(end).toDateString()}. Pay the renewal invoice from Billing to avoid interruption. Renewal is not charged automatically.`],
      expired: ['Your subscription period has ended', 'You have a 3-day grace period. Renew from Billing to keep access.'],
      overdue: ['Your subscription is past due', 'Access will be restricted. Renew from Billing to restore full access.'] }[stage];
    for (const a of await admins(s.company_id)) await notify(s.company_id, a.user_id, 'billing', text[0], text[1], '/billing', { email: true });
  }
}

hooks.usage = checkUsageWarnings;
