import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
import { config } from '../config.js';
import { wrap, parse, HttpError, bad, sha256, addMinutes, isExpired, timingSafeEq } from '../util.js';
import { createRoomTicket } from '../realtime.js';
import { audit, enforce, recordUsage, safeKey, saveFile, deleteFile } from '../services.js';
import { requireAuth, requireTenant, requirePerm, tenant } from '../auth.js';
import { isParticipant } from './interviews.js';
import { runnerInfo } from '../code.js';

export const publicRouter = Router();
const joinLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isProd ? 40 : 400, standardHeaders: true, legacyHeaders: false });

publicRouter.get('/plans', wrap((_req, res) => {
  const rows = db.prepare('SELECT code,name,description,price_monthly,price_yearly,currency,entitlements,trial_days FROM plans WHERE is_public=1 AND is_active=1 ORDER BY sort_order').all() as any[];
  res.json({ items: rows.map(r => ({ ...r, entitlements: j(r.entitlements, {}) })), gstNote: 'Prices exclude GST (18%) for Indian customers.' });
}));
publicRouter.get('/config', wrap((_req, res) => res.json({ razorpayKeyId: config.razorpay.keyId || null, runner: runnerInfo(), devGateway: !config.isProd && !config.razorpay.keyId, appName: 'IntervueX' })));

/* ---------- candidate invitation ---------- */
function loadInvite(raw: string) {
  const inv = db.prepare('SELECT * FROM interview_invitations WHERE token_hash=?').get(sha256(raw)) as any;
  if (!inv) throw new HttpError(404, 'This interview link is not valid.', 'invalid_link');
  if (inv.revoked_at) throw new HttpError(410, 'This link has been replaced or revoked. Please use the latest invitation email.', 'revoked');
  if (isExpired(inv.expires_at)) throw new HttpError(410, 'This interview link has expired.', 'expired');
  const i = db.prepare('SELECT * FROM interviews WHERE id=? AND company_id=?').get(inv.interview_id, inv.company_id) as any;
  if (!i || i.status === 'cancelled') throw new HttpError(410, 'This interview has been cancelled.', 'cancelled');
  if (i.status === 'completed') throw new HttpError(410, 'This interview has already finished.', 'completed');
  const cand = db.prepare(`SELECT c.id, c.name, c.email, jb.title job_title FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs jb ON jb.id=a.job_id WHERE a.id=? AND a.company_id=?`).get(i.application_id, inv.company_id) as any;
  const co = db.prepare('SELECT name FROM companies WHERE id=?').get(inv.company_id) as any;
  return { inv, i, cand, co };
}

export const CONSENT_NOTICE = {
  version: 'v1',
  recording: 'If recording is turned on, your camera, microphone and (if you share it) your screen are recorded so the hiring team can review the interview. Only authorised people at the hiring company can watch it. It is kept for a limited period set by the company and then deleted. You may decline; ask the recruiter about alternatives.',
  secondaryCamera: 'An optional second camera (your phone) can show your workspace, for example your desk and keyboard. It is not a 360° view. Only the interviewers see it live. Nothing is recorded from it unless you separately agree. You can stop it at any time.',
};

publicRouter.get('/join/:token', joinLimiter, wrap((req, res) => {
  const { i, cand, co } = loadInvite(String(req.params.token));
  const cfg = j(i.config, {} as any);
  res.json({
    company: co.name, title: i.title, jobTitle: cand.job_title, scheduledAt: i.scheduled_at, durationMin: i.duration_min, timezone: i.timezone, instructions: i.instructions,
    status: i.status, features: { coding: !!cfg.coding, whiteboard: cfg.whiteboard !== false, recording: !!cfg.recording, secondaryCamera: !!cfg.secondaryCamera }, notice: CONSENT_NOTICE,
    candidateFirstName: cand.name.split(' ')[0], serverTime: now(),
  });
}));

publicRouter.post('/join/:token/ticket', joinLimiter, wrap((req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const { inv, i, cand } = loadInvite(String(req.params.token));
  // identity check: candidate confirms the email the invitation was sent to
  if (!timingSafeEq(b.email, cand.email.toLowerCase())) { audit(inv.company_id, { email: b.email }, 'join.identity_failed', i.id, req); throw new HttpError(403, 'That email does not match this invitation.', 'identity'); }
  const start = new Date(i.scheduled_at).getTime();
  if (Date.now() < start - 30 * 60_000) throw new HttpError(425, 'The interview room opens 30 minutes before the start time.', 'too_early', { opensAt: new Date(start - 30 * 60_000).toISOString() });
  db.prepare('UPDATE interview_invitations SET last_used_at=? WHERE id=?').run(now(), inv.id);
  const ticket = createRoomTicket({ interviewId: i.id, companyId: inv.company_id, kind: 'candidate', name: cand.name, role: 'candidate' });
  res.json({ ticket, iceServers: config.iceServers });
}));

/* ---------- QR secondary camera (phone) ---------- */
function loadCam(raw: string) {
  const s = db.prepare('SELECT * FROM camera_sessions WHERE token_hash=?').get(sha256(raw)) as any;
  if (!s) throw new HttpError(404, 'This QR code is not valid.', 'invalid');
  if (isExpired(s.expires_at)) throw new HttpError(410, 'This QR code has expired. Ask the interviewer to show a new one.', 'expired');
  const i = db.prepare('SELECT status,title FROM interviews WHERE id=? AND company_id=?').get(s.interview_id, s.company_id) as any;
  if (!i || ['cancelled', 'completed'].includes(i.status)) throw new HttpError(410, 'This interview is no longer active.', 'closed');
  return { s, i };
}
publicRouter.get('/camera/:token', joinLimiter, wrap((req, res) => {
  const { s, i } = loadCam(String(req.params.token));
  const co = db.prepare('SELECT name FROM companies WHERE id=?').get(s.company_id) as any;
  const inUse = !!s.claimed_at && !s.ended_at;
  res.json({ company: co.name, title: i.title, inUse, notice: CONSENT_NOTICE.secondaryCamera,
    guidance: ['Place your phone so it shows your desk, keyboard and screen area, roughly at arm\'s length.', 'Use a stand or lean it on something stable, in landscape if possible.', 'Keep it plugged in or charged, and keep this page open.'] });
}));
/** Opening the page never starts the camera. Only after the person ticks consent do we issue a one-time ticket; the browser then still asks for camera permission. */
publicRouter.post('/camera/:token/connect', joinLimiter, wrap((req, res) => {
  const b = parse(z.object({ consent: z.literal(true) }), req.body);
  void b;
  const { s } = loadCam(String(req.params.token));
  if (s.claimed_at && !s.ended_at) throw new HttpError(409, 'This QR code is already in use on another device.', 'in_use');
  db.prepare('UPDATE camera_sessions SET claimed_at=?, ended_at=NULL, expires_at=? WHERE id=?').run(now(), addMinutes(240), s.id);
  const ticket = createRoomTicket({ interviewId: s.interview_id, companyId: s.company_id, kind: 'camera', name: 'Secondary camera', role: 'camera', cameraSessionId: s.id });
  res.json({ ticket, iceServers: config.iceServers });
}));

/* ---------- recording upload (authorised staff, consent enforced server-side) ---------- */
export const mediaRouter = Router();
mediaRouter.use(requireAuth, requireTenant);

mediaRouter.post('/interviews/:id/recordings', requirePerm('interviews.conduct'), wrap((req, res) => {
  const cid = tenant(req);
  const i = db.prepare('SELECT * FROM interviews WHERE id=? AND company_id=?').get(req.params.id, cid) as any;
  if (!i) throw new HttpError(404, 'Interview not found');
  if (!isParticipant(i.id, req.auth!.userId) && !['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Not a participant');
  if (!j(i.config, {} as any).recording) throw bad('Recording is not enabled for this interview');
  const { source, mime } = parse(z.object({ source: z.enum(['main', 'screen', 'secondary_camera']), mime: z.string().regex(/^(video|audio)\/(webm|mp4)/).default('video/webm') }), req.body);
  const consent = (kind: string) => db.prepare('SELECT granted FROM consent_records WHERE interview_id=? AND company_id=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(i.id, cid, kind) as any;
  if (!consent('recording')?.granted) throw new HttpError(403, 'The candidate has not given recording consent.', 'no_consent');
  if (source === 'secondary_camera' && !consent('secondary_recording')?.granted) throw new HttpError(403, 'Separate consent is needed to record the secondary camera.', 'no_consent');
  enforce(cid, { feature: 'recording' });
  const co = db.prepare('SELECT settings FROM companies WHERE id=?').get(cid) as any;
  const days = j(co.settings, {} as any).recordingRetentionDays || 30;
  const id = uid();
  db.prepare('INSERT INTO interview_recordings(id,company_id,interview_id,source,mime,status,started_by,retain_until,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, cid, i.id, source, mime, 'recording', req.auth!.userId, new Date(Date.now() + days * 864e5).toISOString(), now());
  res.status(201).json({ id });
}));

mediaRouter.put('/recordings/:rid/chunk', express.raw({ type: '*/*', limit: '25mb' }), wrap((req, res) => {
  const r = db.prepare('SELECT * FROM interview_recordings WHERE id=? AND company_id=?').get(req.params.rid, tenant(req)) as any;
  if (!r || r.status !== 'recording' || r.started_by !== req.auth!.userId) throw new HttpError(404, 'Recording not found');
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Empty chunk');
  let key = r.file_key;
  if (!key) { key = saveFile(tenant(req), Buffer.alloc(0), '.webm'); db.prepare('UPDATE interview_recordings SET file_key=? WHERE id=?').run(key, r.id); }
  fs.appendFileSync(safeKey(key), buf);
  db.prepare('UPDATE interview_recordings SET size=size+? WHERE id=?').run(buf.length, r.id);
  res.json({ ok: true });
}));

mediaRouter.post('/recordings/:rid/complete', wrap((req, res) => {
  const r = db.prepare('SELECT * FROM interview_recordings WHERE id=? AND company_id=?').get(req.params.rid, tenant(req)) as any;
  if (!r || r.started_by !== req.auth!.userId) throw new HttpError(404, 'Recording not found');
  db.prepare("UPDATE interview_recordings SET status=?, completed_at=? WHERE id=?").run(r.size > 0 ? 'ready' : 'failed', now(), r.id);
  if (r.size > 0) recordUsage(tenant(req), 'recording_mb', Math.round((r.size / 1048576) * 100) / 100, r.id);
  res.json({ ok: true });
}));

/** Retention enforcement: purge recordings past their retain_until date. */
export function purgeExpiredRecordings() {
  const rows = db.prepare("SELECT id,file_key,company_id FROM interview_recordings WHERE retain_until<? AND status!='deleted'").all(now()) as any[];
  for (const r of rows) {
    deleteFile(r.file_key);
    db.prepare("UPDATE interview_recordings SET status='deleted', file_key=NULL WHERE id=?").run(r.id);
    audit(r.company_id, null, 'recording.expired_deleted', r.id);
  }
  return rows.length;
}
export { saveFile };
