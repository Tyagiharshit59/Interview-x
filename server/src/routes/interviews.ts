import { buildIcs } from '../extras.js';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, uid, now, j, tx } from '../db.js';
import { requirePerm, tenant, can } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound, newToken, sha256, addMinutes, isExpired } from '../util.js';
import { audit, logActivity, notify, sendMail, enforce, getEntitlements, recordUsage, signFileToken } from '../services.js';
import { config } from '../config.js';
import { createRoomTicket } from '../realtime.js';

export const interviewRouter = Router();

const cfgSchema = z.object({
  coding: z.boolean().default(true), whiteboard: z.boolean().default(true), recording: z.boolean().default(false),
  secondaryCamera: z.boolean().default(false), codingQuestionId: z.string().nullish(), language: z.string().max(20).default('javascript'),
  allowCandidateScreenShare: z.boolean().default(false),
}).default({});

const body = z.object({
  applicationId: z.string(), title: z.string().trim().min(2).max(150), type: z.enum(['technical', 'hr', 'system_design', 'managerial', 'coding_assessment']).default('technical'),
  scheduledAt: z.string().datetime(), durationMin: z.number().int().min(15).max(480).default(60), timezone: z.string().max(60).default('UTC'),
  instructions: z.string().max(4000).nullish(), interviewerIds: z.array(z.string()).min(1).max(8), config: cfgSchema,
});

async function candidateOf(companyId: string, applicationId: string) {
  const a = await db.applications.get({ id: applicationId, company_id: companyId });
  if (!a) throw notFound('Application not found');
  const c = await db.candidates.get({ id: a.candidate_id });
  const jb = await db.jobs.get({ id: a.job_id });
  if (!c || !jb) throw notFound('Application not found');
  return { application_id: a.id, job_id: a.job_id, job_title: jb.title, candidate_id: c.id, name: c.name, email: c.email } as any;
}

async function inviteLink(interviewId: string, companyId: string) {
  // Revoke earlier links, issue a fresh unguessable one (only hash stored).
  await db.interview_invitations.setMany({ interview_id: interviewId, company_id: companyId, revoked_at: null }, { revoked_at: now() });
  const raw = newToken(32);
  const i = await db.interviews.get({ id: interviewId, company_id: companyId });
  // valid until 2h after scheduled end
  const exp = new Date(new Date(i.scheduled_at).getTime() + (i.duration_min + 120) * 60000).toISOString();
  await db.interview_invitations.insert({ company_id: companyId, interview_id: interviewId, token_hash: sha256(raw), expires_at: exp, created_at: now(), revoked_at: null, last_used_at: null });
  return `${config.appUrl}/join/${raw}`;
}

async function sendInvite(companyId: string, interviewId: string, kind: 'invite' | 'reschedule' | 'cancel' | 'reminder') {
  const i = await db.interviews.get({ id: interviewId, company_id: companyId });
  const cand = await candidateOf(companyId, i.application_id);
  const co = await db.companies.get({ id: companyId });
  const when = new Date(i.scheduled_at).toUTCString();
  if (kind === 'cancel') {
    void sendMail(companyId, cand.email, `Interview cancelled: ${i.title}`, `Hi ${cand.name},\n\nYour interview "${i.title}" with ${co.name} scheduled for ${when} has been cancelled.`,
      [{ filename: 'interview.ics', contentType: 'text/calendar; method=CANCEL', content: buildIcs({ interviewId: i.id, title: `${i.title} — ${co.name}`, start: i.scheduled_at, durationMin: i.duration_min, description: 'Cancelled', method: 'CANCEL', sequence: 99 }) }]);
    return null;
  }
  const link = await inviteLink(interviewId, companyId);
  const cfg = j(i.config, {} as any);
  const subj = { invite: 'Interview invitation', reschedule: 'Interview rescheduled', reminder: 'Reminder: upcoming interview' }[kind];
  void sendMail(companyId, cand.email, `${subj}: ${i.title} — ${co.name}`,
    `Hi ${cand.name},\n\n${co.name} has ${kind === 'reschedule' ? 'rescheduled' : 'scheduled'} your interview for ${cand.job_title}.\n\nWhen: ${when} (${i.timezone})\nDuration: ${i.duration_min} minutes\n` +
    `${i.instructions ? `\nInstructions:\n${i.instructions}\n` : ''}\nJoin link (personal to you, please don't share): ${link}\n\nBefore joining: use a laptop with Chrome/Edge/Firefox/Safari, check your camera and microphone, and find a quiet place.` +
    `${cfg.recording ? '\nThis interview may be recorded; you will be asked for consent before recording begins and can decline.' : ''}` +
    `${cfg.secondaryCamera ? '\nThe interviewer may ask you to optionally share a second camera angle using your phone. This is always optional and requires your explicit consent.' : ''}`,
    [{ filename: 'interview.ics', contentType: 'text/calendar; method=REQUEST', content: buildIcs({ interviewId: i.id, title: `${i.title} — ${co.name}`, start: i.scheduled_at, durationMin: i.duration_min, description: `Interview with ${co.name}. Join with your personal link: ${link}`, method: 'REQUEST', sequence: kind === 'reschedule' ? Math.floor(Date.now() / 1000) % 1000000 : 0 }) }]);
  return link;
}

interviewRouter.get('/interviews', requirePerm('interviews.read'), wrap(async (req, res) => {
  const { status, mine, from, to } = req.query as Record<string, string | undefined>;
  const cid = tenant(req);
  const f: Record<string, any> = { company_id: cid };
  if (status) f.status = status;
  if (from || to) { f.scheduled_at = {}; if (from) f.scheduled_at.$gte = from; if (to) f.scheduled_at.$lte = to; }
  if (mine === '1') {
    const mineIds = (await db.interview_participants.list({ company_id: cid, user_id: req.auth!.userId })).map(p => p.interview_id);
    f.id = { $in: mineIds };
  }
  const ivs = await db.interviews.list(f, { sort: { scheduled_at: -1 }, limit: 300 });
  const ids = ivs.map(i => i.id);
  const apps = await db.applications.list({ company_id: cid, id: { $in: ivs.map(i => i.application_id) } });
  const appById = new Map(apps.map(a => [a.id, a]));
  const cands = await db.candidates.list({ company_id: cid, id: { $in: apps.map(a => a.candidate_id) } });
  const candById = new Map(cands.map(c => [c.id, c]));
  const jobs = await db.jobs.list({ company_id: cid, id: { $in: apps.map(a => a.job_id) } });
  const jobById = new Map(jobs.map(x => [x.id, x]));
  const parts = await db.interview_participants.list({ company_id: cid, interview_id: { $in: ids } }, { sort: { _seq: 1 } });
  const users = await db.users.list({ id: { $in: [...new Set(parts.map(p => p.user_id))] } });
  const userById = new Map(users.map(u => [u.id, u]));
  const namesBy = new Map<string, string[]>();
  for (const p of parts) { const u = userById.get(p.user_id); if (!u) continue; if (!namesBy.has(p.interview_id)) namesBy.set(p.interview_id, []); namesBy.get(p.interview_id)!.push(u.name); }
  const fbs = await db.interview_feedback.list({ company_id: cid, interview_id: { $in: ids }, submitted: 1 }, { projection: { interview_id: 1 } });
  const fbCount = new Map<string, number>();
  for (const x of fbs) fbCount.set(x.interview_id, (fbCount.get(x.interview_id) ?? 0) + 1);
  const items: any[] = [];
  for (const i of ivs) {
    const a = appById.get(i.application_id); const c = a && candById.get(a.candidate_id); const jb = a && jobById.get(a.job_id);
    if (!a || !c || !jb) continue;
    const names = namesBy.get(i.id);
    items.push({ id: i.id, title: i.title, type: i.type, round_no: i.round_no, scheduled_at: i.scheduled_at, duration_min: i.duration_min, status: i.status, application_id: i.application_id,
      candidate_name: c.name, candidate_id: c.id, job_title: jb.title, job_id: jb.id, interviewers: names ? names.join(', ') : null, feedback_count: fbCount.get(i.id) ?? 0 });
  }
  res.json({ items });
}));

interviewRouter.post('/interviews', requirePerm('interviews.schedule'), wrap(async (req, res) => {
  const b = parse(body, req.body);
  const cid = tenant(req);
  const cand = await candidateOf(cid, b.applicationId);
  const ent = await getEntitlements(cid);
  await enforce(cid, { metric: 'interviews', limitKey: 'interviews_per_month' });
  if (b.config.recording) await enforce(cid, { feature: 'recording' });
  if (b.config.secondaryCamera) await enforce(cid, { feature: 'secondary_camera' });
  const co = j<any>((await db.companies.get({ id: cid }))?.settings, {});
  if (b.config.recording && co.recordingEnabled === false) throw bad('Recording is disabled in company settings');
  if (b.config.secondaryCamera && co.secondaryCameraEnabled === false) throw bad('Secondary camera is disabled in company settings');
  for (const uidv of b.interviewerIds) {
    if (!(await db.company_members.exists({ company_id: cid, user_id: uidv, status: 'active' }))) throw bad('An interviewer is not on your team');
  }
  const last = await db.interviews.get({ application_id: b.applicationId, company_id: cid }, { sort: { round_no: -1 } });
  const round = (last?.round_no ?? 0) + 1;
  const id = uid();
  await tx(async () => {
    await db.interviews.insert({ id, company_id: cid, application_id: b.applicationId, round_no: round, title: b.title, type: b.type, scheduled_at: b.scheduledAt, duration_min: b.durationMin, timezone: b.timezone,
      instructions: b.instructions ?? null, config: JSON.stringify(b.config), created_by: req.auth!.userId, created_at: now() });
    for (const [idx, u] of b.interviewerIds.entries()) await db.interview_participants.insert({ company_id: cid, interview_id: id, user_id: u, role: idx === 0 ? 'lead' : 'interviewer' });
    await db.applications.set({ id: b.applicationId, company_id: cid, stage: { $in: ['Applied', 'Screening', 'Shortlisted'] } }, { stage: 'Interview Scheduled', updated_at: now() });
    await recordUsage(cid, 'interviews', 1, id);
  });
  const link = await sendInvite(cid, id, 'invite');
  for (const u of b.interviewerIds) await notify(cid, u, 'interview', `Interview scheduled: ${b.title}`, `${cand.name} · ${new Date(b.scheduledAt).toUTCString()}`, `/interviews/${id}`, { email: true });
  await logActivity(cid, { applicationId: b.applicationId, candidateId: cand.candidate_id, actorId: req.auth!.userId, action: 'interview.scheduled', detail: `${b.title} (round ${round})` });
  await audit(cid, req.auth!, 'interview.scheduled', id, req);
  res.status(201).json({ id, ...(config.isProd ? {} : { devInviteUrl: link }) });
}));

async function getInterview(req: any, id = req.params.id) {
  const i = await db.interviews.get({ id, company_id: tenant(req) });
  if (!i) throw notFound('Interview not found');
  return i as any;
}
export const isParticipant = async (interviewId: string, userId: string): Promise<boolean> => db.interview_participants.exists({ interview_id: interviewId, user_id: userId });

async function participantUsers(interviewId: string, companyId: string) {
  const ps = await db.interview_participants.list({ interview_id: interviewId, company_id: companyId }, { sort: { _seq: 1 } });
  const users = await db.users.list({ id: { $in: ps.map(p => p.user_id) } });
  const byId = new Map(users.map(u => [u.id, u]));
  return ps.filter(p => byId.has(p.user_id)).map(p => { const u = byId.get(p.user_id); return { id: u.id, name: u.name, email: u.email, role: p.role }; });
}

interviewRouter.get('/interviews/:id', requirePerm('interviews.read'), wrap(async (req, res) => {
  const i = await getInterview(req);
  const cand = await candidateOf(tenant(req), i.application_id);
  const participants = await participantUsers(i.id, tenant(req));
  const role = req.auth!.role ?? undefined;
  const mayJoin = (await isParticipant(i.id, req.auth!.userId)) || ['owner', 'admin'].includes(role || '');
  const recordings = can(role, 'recordings.view') ? await db.interview_recordings.list({ interview_id: i.id, company_id: tenant(req) }, { sort: { created_at: 1 }, projection: { source: 1, status: 1, size: 1, created_at: 1, completed_at: 1 } }) : [];
  res.json({ ...i, config: j(i.config, {}), candidate: cand, participants, mayJoin, recordings });
}));

interviewRouter.patch('/interviews/:id', requirePerm('interviews.schedule'), wrap(async (req, res) => {
  const i = await getInterview(req);
  if (['completed', 'cancelled'].includes(i.status)) throw bad('This interview can no longer be changed');
  const b = parse(body.pick({ title: true, scheduledAt: true, durationMin: true, timezone: true, instructions: true, interviewerIds: true, config: true }).partial(), req.body);
  const cid = tenant(req);
  const resched = !!b.scheduledAt && b.scheduledAt !== i.scheduled_at;
  const cfg = b.config ? { ...j(i.config, {}), ...b.config } : j(i.config, {});
  await tx(async () => {
    await db.interviews.set({ id: i.id, company_id: cid }, { title: b.title ?? i.title, scheduled_at: b.scheduledAt ?? i.scheduled_at, duration_min: b.durationMin ?? i.duration_min, timezone: b.timezone ?? i.timezone,
      instructions: b.instructions === undefined ? i.instructions : b.instructions, config: JSON.stringify(cfg) });
    if (b.interviewerIds) {
      for (const u of b.interviewerIds) if (!(await db.company_members.exists({ company_id: cid, user_id: u, status: 'active' }))) throw bad('An interviewer is not on your team');
      await db.interview_participants.del({ interview_id: i.id, company_id: cid });
      for (const [idx, u] of b.interviewerIds.entries()) await db.interview_participants.insert({ company_id: cid, interview_id: i.id, user_id: u, role: idx === 0 ? 'lead' : 'interviewer' });
    }
  });
  if (resched) {
    const link = await sendInvite(cid, i.id, 'reschedule');
    const ps = await db.interview_participants.list({ interview_id: i.id, company_id: cid });
    for (const p of ps) await notify(cid, p.user_id, 'interview', `Interview rescheduled: ${i.title}`, new Date(b.scheduledAt!).toUTCString(), `/interviews/${i.id}`, { email: true });
    return res.json({ ok: true, ...(config.isProd ? {} : { devInviteUrl: link }) });
  }
  res.json({ ok: true });
}));

interviewRouter.post('/interviews/:id/cancel', requirePerm('interviews.schedule'), wrap(async (req, res) => {
  const i = await getInterview(req);
  if (['completed', 'cancelled'].includes(i.status)) throw bad('Already finished');
  const cid = tenant(req);
  await db.interviews.set({ id: i.id, company_id: cid }, { status: 'cancelled' });
  await db.interview_invitations.setMany({ interview_id: i.id, company_id: cid, revoked_at: null }, { revoked_at: now() });
  await sendInvite(cid, i.id, 'cancel');
  for (const p of await db.interview_participants.list({ interview_id: i.id, company_id: cid })) await notify(cid, p.user_id, 'interview', `Interview cancelled: ${i.title}`, undefined, `/interviews/${i.id}`, { email: true });
  await audit(cid, req.auth!, 'interview.cancelled', i.id, req);
  res.json({ ok: true });
}));

interviewRouter.post('/interviews/:id/resend-invite', requirePerm('interviews.schedule'), wrap(async (req, res) => {
  const i = await getInterview(req);
  if (['completed', 'cancelled'].includes(i.status)) throw bad('Interview is closed');
  const link = await sendInvite(tenant(req), i.id, 'reminder');
  res.json({ ok: true, ...(config.isProd ? {} : { devInviteUrl: link }) });
}));

interviewRouter.post('/interviews/:id/revoke-invite', requirePerm('interviews.schedule'), wrap(async (req, res) => {
  const i = await getInterview(req);
  await db.interview_invitations.setMany({ interview_id: i.id, company_id: tenant(req), revoked_at: null }, { revoked_at: now() });
  await audit(tenant(req), req.auth!, 'invite.revoked', i.id, req);
  res.json({ ok: true });
}));

/** Authorised staff: obtain a one-time realtime ticket for the room. */
interviewRouter.post('/interviews/:id/room-ticket', requirePerm('interviews.read'), wrap(async (req, res) => {
  const i = await getInterview(req);
  const role = req.auth!.role!;
  const participant = await isParticipant(i.id, req.auth!.userId);
  if (!participant && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'You are not an interviewer on this interview');
  if (['cancelled'].includes(i.status)) throw bad('This interview was cancelled');
  const ticket = createRoomTicket({ interviewId: i.id, companyId: tenant(req), kind: 'staff', userId: req.auth!.userId, name: req.auth!.name, role: participant ? 'interviewer' : 'observer' });
  res.json({ ticket, iceServers: config.iceServers, interview: { id: i.id, title: i.title, config: j(i.config, {}), durationMin: i.duration_min, scheduledAt: i.scheduled_at, status: i.status } });
}));

/* ---------- secondary camera (QR) ---------- */
interviewRouter.post('/interviews/:id/camera-qr', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const i = await getInterview(req);
  const cfg = j(i.config, {} as any);
  if (!cfg.secondaryCamera) throw bad('Secondary camera is not enabled for this interview');
  await enforce(tenant(req), { feature: 'secondary_camera' });
  await db.camera_sessions.setMany({ interview_id: i.id, company_id: tenant(req), ended_at: null }, { ended_at: now() });
  const raw = newToken(24);
  await db.camera_sessions.insert({ company_id: tenant(req), interview_id: i.id, token_hash: sha256(raw), expires_at: addMinutes(10), created_at: now(), claimed_at: null, ended_at: null });
  const url = `${config.appUrl}/camera/${raw}`;
  res.json({ url, expiresInSec: 600, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }) });
}));

/* ---------- recordings ---------- */
interviewRouter.get('/interviews/:id/playback', requirePerm('recordings.view'), wrap(async (req, res) => {
  const i = await getInterview(req);
  const role = req.auth!.role!;
  const cid = tenant(req);
  if (!(await isParticipant(i.id, req.auth!.userId)) && !['owner', 'admin', 'hiring_manager'].includes(role)) throw new HttpError(403, 'Recording access is limited to interview participants and hiring managers');
  const recs = (await db.interview_recordings.list({ interview_id: i.id, company_id: cid, status: 'ready' }, { projection: { source: 1, size: 1, created_at: 1, completed_at: 1 } }))
    .map(r => ({ ...r, url: `/api/files/${signFileToken({ k: 'recording', id: r.id, cid, uid: req.auth!.userId }, 900)}` }));
  const events = await db.recording_events.list({ interview_id: i.id, company_id: cid }, { sort: { offset_sec: 1 }, projection: { kind: 1, label: 1, offset_sec: 1, created_at: 1 } });
  const snaps = (await db.code_snapshots.list({ interview_id: i.id, company_id: cid }, { sort: { created_at: 1 }, projection: { file_name: 1, language: 1, created_at: 1 } })).map(s => ({ ...s, x: '' }));
  const transcript = (await db.interview_transcripts.list({ interview_id: i.id, company_id: cid }, { sort: { offset_sec: 1 }, projection: { speaker: 1, text: 1, offset_sec: 1 } })).map(({ id: _id, ...t }) => t);
  await audit(cid, req.auth!, 'recording.accessed', i.id, req);
  res.json({ interview: { id: i.id, title: i.title, started_at: i.started_at, ended_at: i.ended_at }, recordings: recs, events, snapshots: snaps, transcript });
}));
interviewRouter.get('/interviews/:id/snapshots/:sid', requirePerm('recordings.view'), wrap(async (req, res) => {
  const i = await getInterview(req);
  const s = await db.code_snapshots.get({ id: req.params.sid, interview_id: i.id, company_id: tenant(req) });
  if (!s) throw notFound();
  res.json(s);
}));
interviewRouter.post('/interviews/:id/bookmarks', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const i = await getInterview(req);
  const b = parse(z.object({ label: z.string().trim().min(1).max(300), offsetSec: z.number().min(0).max(86400 * 2), kind: z.enum(['bookmark', 'note']).default('bookmark') }), req.body);
  await db.recording_events.insert({ company_id: tenant(req), interview_id: i.id, kind: b.kind, label: b.label, offset_sec: b.offsetSec, author_id: req.auth!.userId, created_at: now() });
  res.status(201).json({ ok: true });
}));
interviewRouter.delete('/recordings/:rid', requirePerm('recordings.delete'), wrap(async (req, res) => {
  const r = await db.interview_recordings.get({ id: req.params.rid, company_id: tenant(req) });
  if (!r) throw notFound();
  const { deleteFile } = await import('../services.js');
  deleteFile(r.file_key);
  await db.interview_recordings.set({ id: r.id, company_id: tenant(req) }, { status: 'deleted', file_key: null });
  await audit(tenant(req), req.auth!, 'recording.deleted', r.id, req);
  res.json({ ok: true });
}));
export { isExpired };

/** An existing participant (or admin) can add another authorised team member mid-session. */
interviewRouter.post('/interviews/:id/participants', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const i = await getInterview(req);
  if (!(await isParticipant(i.id, req.auth!.userId)) && !['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Only participants can add others');
  if (['completed', 'cancelled'].includes(i.status)) throw bad('Interview is closed');
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const m = await db.company_members.get({ company_id: tenant(req), user_id: userId, status: 'active' });
  if (!m) throw bad('That person is not on your team');
  if (!can(m.role, 'interviews.conduct')) throw bad('That role cannot take part in interviews');
  await db.interview_participants.upsert({ interview_id: i.id, user_id: userId }, {}, { id: uid(), company_id: tenant(req), role: 'interviewer' });
  await notify(tenant(req), userId, 'interview', `You were added to: ${i.title}`, undefined, `/interviews/${i.id}/room`, { email: false });
  await audit(tenant(req), req.auth!, 'interview.participant_added', i.id, req, { userId });
  res.json({ ok: true });
}));
