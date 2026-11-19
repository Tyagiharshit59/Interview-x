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
export function audit(companyId: string | null, actor: { userId?: string; email?: string } | null, action: string, target?: string, req?: Request, detail?: any) {
  db.prepare('INSERT INTO audit_logs(id,company_id,actor_id,actor_label,action,target,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), companyId, actor?.userId ?? null, actor?.email ?? null, action, target ?? null, detail ? JSON.stringify(detail) : null, req ? clientIp(req) : null, now());
}

export function logActivity(companyId: string, a: { applicationId?: string; candidateId?: string; actorId?: string; action: string; detail?: string }) {
  db.prepare('INSERT INTO activity(id,company_id,application_id,candidate_id,actor_id,action,detail,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid(), companyId, a.applicationId ?? null, a.candidateId ?? null, a.actorId ?? null, a.action, a.detail ?? null, now());
}

/* ---------------- mail ---------------- */
let transporter: nodemailer.Transporter | null = null;
if (config.smtp) {
  transporter = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
}
export async function sendMail(companyId: string | null, to: string, subject: string, body: string) {
  const id = uid();
  db.prepare('INSERT INTO email_outbox(id,company_id,to_email,subject,body,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, companyId, to, subject, body, 'queued', now());
  if (!transporter) {
    db.prepare("UPDATE email_outbox SET status='logged', sent_at=? WHERE id=?").run(now(), id);
    if (!config.isProd) console.log(`\n[mail:dev] To: ${to}\n  Subject: ${subject}\n  ${body.replace(/\n/g, '\n  ')}\n`);
    return;
  }
  try {
    await transporter.sendMail({ from: config.mailFrom, to, subject, text: body });
    db.prepare("UPDATE email_outbox SET status='sent', sent_at=? WHERE id=?").run(now(), id);
  } catch (e: any) {
    db.prepare("UPDATE email_outbox SET status='failed', error=? WHERE id=?").run(String(e?.message || e), id);
  }
}

/* ---------------- notifications ---------------- */
export function notify(companyId: string | null, userId: string, kind: string, title: string, body?: string, link?: string, opts: { email?: boolean } = {}) {
  db.prepare('INSERT INTO notifications(id,company_id,user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid(), companyId, userId, kind, title, body ?? null, link ?? null, now());
  if (opts.email) {
    const u = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as any;
    const p = db.prepare('SELECT email_enabled FROM notification_prefs WHERE user_id=?').get(userId) as any;
    if (u && (!p || p.email_enabled)) void sendMail(companyId, u.email, title, `${body ?? ''}\n${link ? config.appUrl + link : ''}`.trim());
  }
}

/* ---------------- entitlements & usage ---------------- */
export const DEFAULT_ENTITLEMENTS = {
  members: 2, interviews_per_month: 20, recording: false, coding: true, code_runs_per_month: 200, ai: false, ai_calls_per_month: 0,
  secondary_camera: false, recording_retention_days: 30, recording_storage_mb: 0, analytics: false, sso: false, api_access: false, custom_evaluation: false,
};
export type Entitlements = typeof DEFAULT_ENTITLEMENTS;

export function getSubscription(companyId: string) {
  const s = db.prepare('SELECT s.*, p.name plan_name, p.code plan_code, p.entitlements, p.overage FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.company_id=?').get(companyId) as any;
  return s;
}
export function getEntitlements(companyId: string): Entitlements & { _status: string; _active: boolean } {
  const s = getSubscription(companyId);
  if (!s) return { ...DEFAULT_ENTITLEMENTS, interviews_per_month: 0, members: 1, _status: 'none', _active: false };
  let status = s.status;
  if (status === 'trialing' && s.trial_ends_at && new Date(s.trial_ends_at) < new Date()) status = 'expired';
  if (status === 'active' && new Date(s.current_period_end) < new Date(Date.now() - 3 * 864e5)) status = 'past_due';
  const base = { ...DEFAULT_ENTITLEMENTS, ...j(s.entitlements, {}), ...j(s.custom_entitlements, {}) };
  const active = status === 'trialing' || status === 'active' || (status === 'past_due');
  return { ...base, _status: status, _active: active };
}

export function periodStart(companyId: string) {
  const s = getSubscription(companyId);
  return s?.current_period_start || new Date(Date.now() - 30 * 864e5).toISOString();
}
export function recordUsage(companyId: string, metric: string, quantity = 1, refId?: string) {
  db.prepare('INSERT INTO usage_records(id,company_id,metric,quantity,ref_id,created_at) VALUES (?,?,?,?,?,?)').run(uid(), companyId, metric, quantity, refId ?? null, now());
}
export function usageTotal(companyId: string, metric: string) {
  const r = db.prepare('SELECT COALESCE(SUM(quantity),0) t FROM usage_records WHERE company_id=? AND metric=? AND created_at>=?').get(companyId, metric, periodStart(companyId)) as any;
  return r.t as number;
}
export function usageSummary(companyId: string) {
  const e = getEntitlements(companyId) as any;
  const metrics: Array<[string, string | null]> = [
    ['interviews', 'interviews_per_month'], ['interview_minutes', null], ['code_runs', 'code_runs_per_month'],
    ['ai_calls', 'ai_calls_per_month'], ['recording_mb', 'recording_storage_mb'],
  ];
  const members = (db.prepare("SELECT COUNT(*) c FROM company_members WHERE company_id=? AND status='active'").get(companyId) as any).c;
  return {
    status: e._status,
    members: { used: members, limit: e.members },
    ...Object.fromEntries(metrics.map(([m, k]) => [m, { used: Math.round(usageTotal(companyId, m) * 10) / 10, limit: k ? e[k] : null }])),
  };
}
/** Throws 402 if the feature isn't in the plan or the monthly cap is hit. Limit <= 0 on a counted metric means "none included". */
export function enforce(companyId: string, opts: { feature?: keyof Entitlements; metric?: string; limitKey?: keyof Entitlements; add?: number }) {
  const e = getEntitlements(companyId);
  if (!e._active) throw new HttpError(402, 'Your subscription is not active. Please renew or upgrade to continue.', 'subscription_inactive');
  if (opts.feature && !e[opts.feature]) throw new HttpError(402, `This feature is not included in your plan (${String(opts.feature)}).`, 'feature_not_in_plan');
  if (opts.metric && opts.limitKey) {
    const limit = e[opts.limitKey] as number;
    if (limit !== -1) { // -1 = unlimited
      const used = usageTotal(companyId, opts.metric);
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
