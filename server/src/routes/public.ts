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
import { logoUrl, themeOf } from '../branding.js';

export const publicRouter = Router();
const joinLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isProd ? 40 : 400, standardHeaders: true, legacyHeaders: false });

publicRouter.get('/plans', wrap(async (_req, res) => {
  const rows = await db.plans.list({ is_public: 1, is_active: 1 }, { sort: { sort_order: 1 }, projection: { code: 1, name: 1, description: 1, price_monthly: 1, price_yearly: 1, currency: 1, entitlements: 1, trial_days: 1 } });
  res.json({ items: rows.map(({ id: _id, ...r }) => ({ ...r, entitlements: j(r.entitlements, {}) })), gstNote: 'Prices exclude GST (18%) for Indian customers.' });
}));
publicRouter.get('/config', wrap((_req, res) => res.json({ razorpayKeyId: config.razorpay.keyId || null, runner: runnerInfo(), devGateway: !config.isProd && !config.razorpay.keyId, appName: 'IntervueX' })));

/* ---------- candidate invitation ---------- */
async function loadInvite(raw: string) {
  const inv = await db.interview_invitations.get({ token_hash: sha256(raw) });
  if (!inv) throw new HttpError(404, 'This interview link is not valid.', 'invalid_link');
  if (inv.revoked_at) throw new HttpError(410, 'This link has been replaced or revoked. Please use the latest invitation email.', 'revoked');
  if (isExpired(inv.expires_at)) throw new HttpError(410, 'This interview link has expired.', 'expired');
  const i = await db.interviews.get({ id: inv.interview_id, company_id: inv.company_id });
  if (!i || i.status === 'cancelled') throw new HttpError(410, 'This interview has been cancelled.', 'cancelled');
  if (i.status === 'completed') throw new HttpError(410, 'This interview has already finished.', 'completed');
  const app = await db.applications.get({ id: i.application_id, company_id: inv.company_id });
  const c = app && await db.candidates.get({ id: app.candidate_id });
  const jb = app && await db.jobs.get({ id: app.job_id });
  const cand = c && jb ? { id: c.id, name: c.name, email: c.email, job_title: jb.title } as any : undefined;
  const co = await db.companies.get({ id: inv.company_id });
  return { inv, i, cand, co };
}

export const CONSENT_NOTICE = {
  version: 'v1',
  recording: 'If recording is turned on, your camera, microphone and (if you share it) your screen are recorded so the hiring team can review the interview. Only authorised people at the hiring company can watch it. It is kept for a limited period set by the company and then deleted. You may decline; ask the recruiter about alternatives.',
  secondaryCamera: 'An optional second camera (your phone) can show your workspace, for example your desk and keyboard. It is not a 360° view. Only the interviewers see it live. Nothing is recorded from it unless you separately agree. You can stop it at any time.',
};

publicRouter.get('/join/:token', joinLimiter, wrap(async (req, res) => {
  const { i, cand, co } = await loadInvite(String(req.params.token));
  const cfg = j(i.config, {} as any);
  res.json({
    company: co.name, companyLogo: logoUrl(co), themeColor: themeOf(co), title: i.title, jobTitle: cand.job_title, scheduledAt: i.scheduled_at, durationMin: i.duration_min, timezone: i.timezone, instructions: i.instructions,
    status: i.status, features: { coding: !!cfg.coding, whiteboard: cfg.whiteboard !== false, recording: !!cfg.recording, secondaryCamera: !!cfg.secondaryCamera }, notice: CONSENT_NOTICE,
    candidateFirstName: cand.name.split(' ')[0], serverTime: now(),
  });
}));

publicRouter.post('/join/:token/ticket', joinLimiter, wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const { inv, i, cand } = await loadInvite(String(req.params.token));
  // identity check: candidate confirms the email the invitation was sent to
  if (!timingSafeEq(b.email, cand.email.toLowerCase())) { await audit(inv.company_id, { email: b.email }, 'join.identity_failed', i.id, req); throw new HttpError(403, 'That email does not match this invitation.', 'identity'); }
  const start = new Date(i.scheduled_at).getTime();
  if (Date.now() < start - 30 * 60_000) throw new HttpError(425, 'The interview room opens 30 minutes before the start time.', 'too_early', { opensAt: new Date(start - 30 * 60_000).toISOString() });
  await db.interview_invitations.set({ id: inv.id }, { last_used_at: now() });
  const ticket = createRoomTicket({ interviewId: i.id, companyId: inv.company_id, kind: 'candidate', name: cand.name, role: 'candidate' });
  res.json({ ticket, iceServers: config.iceServers });
}));

/* ---------- QR secondary camera (phone) ---------- */
async function loadCam(raw: string) {
  const s = await db.camera_sessions.get({ token_hash: sha256(raw) });
  if (!s) throw new HttpError(404, 'This QR code is not valid.', 'invalid');
  if (isExpired(s.expires_at)) throw new HttpError(410, 'This QR code has expired. Ask the interviewer to show a new one.', 'expired');
  const i = await db.interviews.get({ id: s.interview_id, company_id: s.company_id });
  if (!i || ['cancelled', 'completed'].includes(i.status)) throw new HttpError(410, 'This interview is no longer active.', 'closed');
  return { s, i };
}
publicRouter.get('/camera/:token', joinLimiter, wrap(async (req, res) => {
  const { s, i } = await loadCam(String(req.params.token));
  const co = await db.companies.get({ id: s.company_id });
  const inUse = !!s.claimed_at && !s.ended_at;
  res.json({ company: co.name, title: i.title, inUse, notice: CONSENT_NOTICE.secondaryCamera,
    guidance: ['Place your phone so it shows your desk, keyboard and screen area, roughly at arm\'s length.', 'Use a stand or lean it on something stable, in landscape if possible.', 'Keep it plugged in or charged, and keep this page open.'] });
}));
/** Opening the page never starts the camera. Only after the person ticks consent do we issue a one-time ticket; the browser then still asks for camera permission. */
publicRouter.post('/camera/:token/connect', joinLimiter, wrap(async (req, res) => {
  const b = parse(z.object({ consent: z.literal(true) }), req.body);
  void b;
  const { s } = await loadCam(String(req.params.token));
  if (s.claimed_at && !s.ended_at) throw new HttpError(409, 'This QR code is already in use on another device.', 'in_use');
  await db.camera_sessions.set({ id: s.id, company_id: s.company_id }, { claimed_at: now(), ended_at: null, expires_at: addMinutes(240) });
  const ticket = createRoomTicket({ interviewId: s.interview_id, companyId: s.company_id, kind: 'camera', name: 'Secondary camera', role: 'camera', cameraSessionId: s.id });
  res.json({ ticket, iceServers: config.iceServers });
}));

/* ---------- recording upload (authorised staff, consent enforced server-side) ---------- */
export const mediaRouter = Router();
mediaRouter.use(requireAuth, requireTenant);

mediaRouter.post('/interviews/:id/recordings', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const cid = tenant(req);
  const i = await db.interviews.get({ id: req.params.id, company_id: cid });
  if (!i) throw new HttpError(404, 'Interview not found');
  if (!(await isParticipant(i.id, req.auth!.userId)) && !['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Not a participant');
  if (!j(i.config, {} as any).recording) throw bad('Recording is not enabled for this interview');
  const { source, mime } = parse(z.object({ source: z.enum(['main', 'screen', 'secondary_camera']), mime: z.string().regex(/^(video|audio)\/(webm|mp4)/).default('video/webm') }), req.body);
  const consent = (kind: string) => db.consent_records.get({ interview_id: i.id, company_id: cid, kind }, { sort: { created_at: -1 } });
  if (!(await consent('recording'))?.granted) throw new HttpError(403, 'The candidate has not given recording consent.', 'no_consent');
  if (source === 'secondary_camera' && !(await consent('secondary_recording'))?.granted) throw new HttpError(403, 'Separate consent is needed to record the secondary camera.', 'no_consent');
  await enforce(cid, { feature: 'recording' });
  const co = await db.companies.get({ id: cid });
  const days = j(co.settings, {} as any).recordingRetentionDays || 30;
  const id = uid();
  await db.interview_recordings.insert({ id, company_id: cid, interview_id: i.id, source, mime, status: 'recording', started_by: req.auth!.userId, retain_until: new Date(Date.now() + days * 864e5).toISOString(), created_at: now(), size: 0, file_key: null, completed_at: null });
  res.status(201).json({ id });
}));

mediaRouter.put('/recordings/:rid/chunk', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
  const r = await db.interview_recordings.get({ id: req.params.rid, company_id: tenant(req) });
  if (!r || r.status !== 'recording' || r.started_by !== req.auth!.userId) throw new HttpError(404, 'Recording not found');
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Empty chunk');
  let key = r.file_key;
  if (!key) { key = saveFile(tenant(req), Buffer.alloc(0), '.webm'); await db.interview_recordings.set({ id: r.id, company_id: tenant(req) }, { file_key: key }); }
  fs.appendFileSync(safeKey(key), buf);
  await db.interview_recordings.inc({ id: r.id, company_id: tenant(req) }, { size: buf.length });
  res.json({ ok: true });
}));

mediaRouter.post('/recordings/:rid/complete', wrap(async (req, res) => {
  const r = await db.interview_recordings.get({ id: req.params.rid, company_id: tenant(req) });
  if (!r || r.started_by !== req.auth!.userId) throw new HttpError(404, 'Recording not found');
  await db.interview_recordings.set({ id: r.id, company_id: tenant(req) }, { status: r.size > 0 ? 'ready' : 'failed', completed_at: now() });
  if (r.size > 0) await recordUsage(tenant(req), 'recording_mb', Math.round((r.size / 1048576) * 100) / 100, r.id);
  res.json({ ok: true });
}));

/** Retention enforcement: purge recordings past their retain_until date. */
export async function purgeExpiredRecordings() {
  const rows = await db.interview_recordings.list({ retain_until: { $lt: now() }, status: { $ne: 'deleted' } }, { projection: { file_key: 1, company_id: 1 } });
  for (const r of rows) {
    deleteFile(r.file_key);
    await db.interview_recordings.set({ id: r.id }, { status: 'deleted', file_key: null });
    await audit(r.company_id, null, 'recording.expired_deleted', r.id);
  }
  return rows.length;
}
export { saveFile };
