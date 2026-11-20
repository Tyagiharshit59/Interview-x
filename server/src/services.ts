import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import type { Request } from 'express';
import { db, uid, now, j } from './db.js';
import { config } from './config.js';
import { HttpError, clientIp } from './util.js';

/* ---------------- audit ---------------- */
export async function audit(companyId: string | null, actor: { userId?: string; email?: string } | null, action: string, target?: string, req?: Request, detail?: any) {
  await db.audit_logs.insert({ company_id: companyId, actor_id: actor?.userId ?? null, actor_label: actor?.email ?? null, action, target: target ?? null, detail: detail ? JSON.stringify(detail) : null, ip: req ? clientIp(req) : null, created_at: now() });
}

export async function logActivity(companyId: string, a: { applicationId?: string; candidateId?: string; actorId?: string; action: string; detail?: string }) {
  await db.activity.insert({ company_id: companyId, application_id: a.applicationId ?? null, candidate_id: a.candidateId ?? null, actor_id: a.actorId ?? null, action: a.action, detail: a.detail ?? null, created_at: now() });
}

/* ---------------- mail ---------------- */
let transporter: nodemailer.Transporter | null = null;
if (config.smtp) {
  transporter = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
}
export type MailAttachment = { filename: string; content: string; contentType: string };
export async function sendMail(companyId: string | null, to: string, subject: string, body: string, attachments?: MailAttachment[]) {
  const id = await db.email_outbox.insert({ company_id: companyId, to_email: to, subject, body, status: 'queued', created_at: now() });
  if (!transporter) {
    await db.email_outbox.set({ id }, { status: 'logged', sent_at: now() });
    if (!config.isProd) console.log(`\n[mail:dev] To: ${to}\n  Subject: ${subject}\n  ${body.replace(/\n/g, '\n  ')}\n`);
    return;
  }
  try {
    await transporter.sendMail({ from: config.mailFrom, to, subject, text: body, attachments: attachments?.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })) });
    await db.email_outbox.set({ id }, { status: 'sent', sent_at: now() });
  } catch (e: any) {
    await db.email_outbox.set({ id }, { status: 'failed', error: String(e?.message || e) });
  }
}

/* ---------------- notifications ---------------- */
export async function notify(companyId: string | null, userId: string, kind: string, title: string, body?: string, link?: string, opts: { email?: boolean } = {}) {
  await db.notifications.insert({ company_id: companyId, user_id: userId, kind, title, body: body ?? null, link: link ?? null, read_at: null, created_at: now() });
  if (opts.email) {
    const u = await db.users.get({ id: userId });
    const p = await db.notification_prefs.get({ user_id: userId });
    if (u && (!p || p.email_enabled)) void sendMail(companyId, u.email, title, `${body ?? ''}\n${link ? config.appUrl + link : ''}`.trim());
  }
}

/* ---------------- entitlements & usage ---------------- */
export const DEFAULT_ENTITLEMENTS = {
  members: 2, interviews_per_month: 20, recording: false, coding: true, code_runs_per_month: 200, ai: false, ai_calls_per_month: 0,
  secondary_camera: false, recording_retention_days: 30, recording_storage_mb: 0, analytics: false, sso: false, api_access: false, custom_evaluation: false,
};
export type Entitlements = typeof DEFAULT_ENTITLEMENTS;

/** Subscription merged with its plan (plan_name, plan_code, entitlements, overage), or null. */
export async function getSubscription(companyId: string) {
  const s = await db.subscriptions.get({ company_id: companyId });
  if (!s) return null;
  const p = await db.plans.get({ id: s.plan_id });
  return { ...s, plan_name: p?.name, plan_code: p?.code, entitlements: p?.entitlements ?? '{}', overage: p?.overage ?? '{}' } as any;
}
export async function getEntitlements(companyId: string): Promise<Entitlements & { _status: string; _active: boolean }> {
  const s = await getSubscription(companyId);
  if (!s) return { ...DEFAULT_ENTITLEMENTS, interviews_per_month: 0, members: 1, _status: 'none', _active: false };
  let status = s.status;
  if (status === 'trialing' && s.trial_ends_at && new Date(s.trial_ends_at) < new Date()) status = 'expired';
  if (status === 'active' && new Date(s.current_period_end) < new Date(Date.now() - 3 * 864e5)) status = 'past_due';
  const base = { ...DEFAULT_ENTITLEMENTS, ...j(s.entitlements, {}), ...j(s.custom_entitlements, {}) };
  const active = status === 'trialing' || status === 'active' || (status === 'past_due');
  return { ...base, _status: status, _active: active };
}

export async function periodStart(companyId: string) {
  const s = await getSubscription(companyId);
  return (s?.current_period_start as string) || new Date(Date.now() - 30 * 864e5).toISOString();
}
export const hooks: { usage?: (companyId: string, metric: string) => Promise<void> | void } = {};
export async function recordUsage(companyId: string, metric: string, quantity = 1, refId?: string) {
  await db.usage_records.insert({ company_id: companyId, metric, quantity, ref_id: refId ?? null, created_at: now() });
  await hooks.usage?.(companyId, metric);
}
export async function usageTotal(companyId: string, metric: string) {
  return db.usage_records.sum('quantity', { company_id: companyId, metric, created_at: { $gte: await periodStart(companyId) } });
}
export async function usageSummary(companyId: string) {
  const e = (await getEntitlements(companyId)) as any;
  const metrics: Array<[string, string | null]> = [
    ['interviews', 'interviews_per_month'], ['interview_minutes', null], ['code_runs', 'code_runs_per_month'],
    ['ai_calls', 'ai_calls_per_month'], ['recording_mb', 'recording_storage_mb'],
  ];
  const members = await db.company_members.count({ company_id: companyId, status: 'active' });
  const used: Record<string, any> = {};
  for (const [m, k] of metrics) used[m] = { used: Math.round((await usageTotal(companyId, m)) * 10) / 10, limit: k ? e[k] : null };
  return { status: e._status, members: { used: members, limit: e.members }, ...used };
}
/** Throws 402 if the feature isn't in the plan or the monthly cap is hit. Limit <= 0 on a counted metric means "none included". */
export async function enforce(companyId: string, opts: { feature?: keyof Entitlements; metric?: string; limitKey?: keyof Entitlements; add?: number }) {
  const e = await getEntitlements(companyId);
  if (!e._active) throw new HttpError(402, 'Your subscription is not active. Please renew or upgrade to continue.', 'subscription_inactive');
  if (opts.feature && !e[opts.feature]) throw new HttpError(402, `This feature is not included in your plan (${String(opts.feature)}).`, 'feature_not_in_plan');
  if (opts.metric && opts.limitKey) {
    const limit = e[opts.limitKey] as number;
    if (limit !== -1) { // -1 = unlimited
      const used = await usageTotal(companyId, opts.metric);
      if (used + (opts.add ?? 1) > limit) throw new HttpError(402, `Monthly limit reached for ${opts.metric} (${limit}). Upgrade your plan or buy an add-on.`, 'limit_reached', { used, limit });
    }
  }
}

/* ---------------- file storage ---------------- */
export const filesDir = path.join(config.storageDir, 'files');
fs.mkdirSync(filesDir, { recursive: true });

export function safeKey(key: string) {
  const full = path.resolve(filesDir, key);
  if (!full.startsWith(path.resolve(filesDir) + path.sep)) throw new HttpError(400, 'Bad file key');
  return full;
}
export function saveFile(companyId: string, buf: Buffer, ext: string) {
  const key = `${companyId}/${uid()}${ext}`;
  const full = safeKey(key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  return key;
}
export function deleteFile(key: string | null | undefined) { if (key) { try { fs.unlinkSync(safeKey(key)); } catch { /* already gone */ } } }

/** Magic-byte validation for resume/JD documents. */
export function detectDoc(buf: Buffer): 'pdf' | 'docx' | 'doc' | 'txt' | null {
  if (buf.slice(0, 4).toString() === '%PDF') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'docx';
  if (buf.slice(0, 4).toString('hex') === 'd0cf11e0') return 'doc';
  if (!buf.slice(0, 2000).includes(0)) return 'txt';
  return null;
}
/**
 * Malware scan hook. Dev: signature check for the EICAR test string only.
 * Production: wire ClamAV (clamd) or a cloud scanner here and fail closed.
 */
export async function scanFile(buf: Buffer) {
  if (buf.includes(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'))) throw new HttpError(422, 'File rejected by malware scan', 'malware');
}

/** Short-lived signed download token. The file route re-checks tenant ownership. */
export function signFileToken(payload: { k: 'resume' | 'recording' | 'chatfile'; id: string; cid: string; uid: string }, ttlSec = 300) {
  return jwt.sign(payload, config.jwtSecret + ':file', { expiresIn: ttlSec });
}
export function verifyFileToken(t: string) {
  try { return jwt.verify(t, config.jwtSecret + ':file') as any; } catch { throw new HttpError(403, 'Link expired or invalid', 'bad_link'); }
}

export const randomId = (n = 8) => crypto.randomBytes(n).toString('hex');
