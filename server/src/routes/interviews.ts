import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
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

function candidateOf(companyId: string, applicationId: string) {
  const r = db.prepare(`SELECT a.id application_id, a.job_id, jb.title job_title, c.id candidate_id, c.name, c.email FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs jb ON jb.id=a.job_id
    WHERE a.id=? AND a.company_id=?`).get(applicationId, companyId) as any;
  if (!r) throw notFound('Application not found');
  return r;
}

function inviteLink(interviewId: string, companyId: string) {
  // Revoke earlier links, issue a fresh unguessable one (only hash stored).
  db.prepare('UPDATE interview_invitations SET revoked_at=? WHERE interview_id=? AND company_id=? AND revoked_at IS NULL').run(now(), interviewId, companyId);
  const raw = newToken(32);
  const i = db.prepare('SELECT scheduled_at, duration_min FROM interviews WHERE id=?').get(interviewId) as any;
  // valid until 2h after scheduled end
  const exp = new Date(new Date(i.scheduled_at).getTime() + (i.duration_min + 120) * 60000).toISOString();
  db.prepare('INSERT INTO interview_invitations(id,company_id,interview_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(uid(), companyId, interviewId, sha256(raw), exp, now());
  return `${config.appUrl}/join/${raw}`;
}

function sendInvite(companyId: string, interviewId: string, kind: 'invite' | 'reschedule' | 'cancel' | 'reminder') {
  const i = db.prepare('SELECT * FROM interviews WHERE id=? AND company_id=?').get(interviewId, companyId) as any;
  const cand = candidateOf(companyId, i.application_id);
  const co = db.prepare('SELECT name FROM companies WHERE id=?').get(companyId) as any;
  const when = new Date(i.scheduled_at).toUTCString();
  if (kind === 'cancel') {
    void sendMail(companyId, cand.email, `Interview cancelled: ${i.title}`, `Hi ${cand.name},\n\nYour interview "${i.title}" with ${co.name} scheduled for ${when} has been cancelled.`);
    return null;
  }
  const link = inviteLink(interviewId, companyId);
  const cfg = j(i.config, {} as any);
  const subj = { invite: 'Interview invitation', reschedule: 'Interview rescheduled', reminder: 'Reminder: upcoming interview' }[kind];
  void sendMail(companyId, cand.email, `${subj}: ${i.title} — ${co.name}`,
    `Hi ${cand.name},\n\n${co.name} has ${kind === 'reschedule' ? 'rescheduled' : 'scheduled'} your interview for ${cand.job_title}.\n\nWhen: ${when} (${i.timezone})\nDuration: ${i.duration_min} minutes\n` +
    `${i.instructions ? `\nInstructions:\n${i.instructions}\n` : ''}\nJoin link (personal to you, please don't share): ${link}\n\nBefore joining: use a laptop with Chrome/Edge/Firefox/Safari, check your camera and microphone, and find a quiet place.` +
    `${cfg.recording ? '\nThis interview may be recorded; you will be asked for consent before recording begins and can decline.' : ''}` +
    `${cfg.secondaryCamera ? '\nThe interviewer may ask you to optionally share a second camera angle using your phone. This is always optional and requires your explicit consent.' : ''}`);
  return link;
}

interviewRouter.get('/interviews', requirePerm('interviews.read'), wrap((req, res) => {
  const { status, mine, from, to } = req.query as Record<string, string | undefined>;
  let sql = `SELECT i.id,i.title,i.type,i.round_no,i.scheduled_at,i.duration_min,i.status,i.application_id, c.name candidate_name, c.id candidate_id, jb.title job_title, jb.id job_id,
    (SELECT group_concat(u.name, ', ') FROM interview_participants p JOIN users u ON u.id=p.user_id WHERE p.interview_id=i.id) interviewers,
    (SELECT COUNT(*) FROM interview_feedback f WHERE f.interview_id=i.id AND f.submitted=1) feedback_count
    FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs jb ON jb.id=a.job_id WHERE i.company_id=?`;
  const args: any[] = [tenant(req)];
  if (status) { sql += ' AND i.status=?'; args.push(status); }
  if (from) { sql += ' AND i.scheduled_at>=?'; args.push(from); }
  if (to) { sql += ' AND i.scheduled_at<=?'; args.push(to); }
  if (mine === '1') { sql += ' AND EXISTS (SELECT 1 FROM interview_participants p WHERE p.interview_id=i.id AND p.user_id=?)'; args.push(req.auth!.userId); }
  res.json({ items: db.prepare(sql + ' ORDER BY i.scheduled_at DESC LIMIT 300').all(...args) });
}));

interviewRouter.post('/interviews', requirePerm('interviews.schedule'), wrap((req, res) => {
  const b = parse(body, req.body);
  const cid = tenant(req);
  const cand = candidateOf(cid, b.applicationId);
  const ent = getEntitlements(cid);
  enforce(cid, { metric: 'interviews', limitKey: 'interviews_per_month' });
  if (b.config.recording) enforce(cid, { feature: 'recording' });
  if (b.config.secondaryCamera) enforce(cid, { feature: 'secondary_camera' });
  const co = j<any>((db.prepare('SELECT settings FROM companies WHERE id=?').get(cid) as any).settings, {});
  if (b.config.recording && co.recordingEnabled === false) throw bad('Recording is disabled in company settings');
  if (b.config.secondaryCamera && co.secondaryCameraEnabled === false) throw bad('Secondary camera is disabled in company settings');
  for (const uidv of b.interviewerIds) {
    if (!db.prepare("SELECT 1 FROM company_members WHERE company_id=? AND user_id=? AND status='active'").get(cid, uidv)) throw bad('An interviewer is not on your team');
  }
  const round = (db.prepare('SELECT COALESCE(MAX(round_no),0)+1 n FROM interviews WHERE application_id=? AND company_id=?').get(b.applicationId, cid) as any).n;
  const id = uid();
  db.transaction(() => {
    db.prepare(`INSERT INTO interviews(id,company_id,application_id,round_no,title,type,scheduled_at,duration_min,timezone,instructions,config,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, cid, b.applicationId, round, b.title, b.type, b.scheduledAt, b.durationMin, b.timezone, b.instructions ?? null, JSON.stringify(b.config), req.auth!.userId, now());
    b.interviewerIds.forEach((u, idx) => db.prepare('INSERT INTO interview_participants(id,company_id,interview_id,user_id,role) VALUES (?,?,?,?,?)').run(uid(), cid, id, u, idx === 0 ? 'lead' : 'interviewer'));
    db.prepare("UPDATE applications SET stage='Interview Scheduled', updated_at=? WHERE id=? AND stage IN ('Applied','Screening','Shortlisted')").run(now(), b.applicationId);
    recordUsage(cid, 'interviews', 1, id);
  })();
  const link = sendInvite(cid, id, 'invite');
  for (const u of b.interviewerIds) notify(cid, u, 'interview', `Interview scheduled: ${b.title}`, `${cand.name} · ${new Date(b.scheduledAt).toUTCString()}`, `/interviews/${id}`, { email: true });
  logActivity(cid, { applicationId: b.applicationId, candidateId: cand.candidate_id, actorId: req.auth!.userId, action: 'interview.scheduled', detail: `${b.title} (round ${round})` });
  audit(cid, req.auth!, 'interview.scheduled', id, req);
  res.status(201).json({ id, ...(config.isProd ? {} : { devInviteUrl: link }) });
}));

function getInterview(req: any, id = req.params.id) {
  const i = db.prepare('SELECT * FROM interviews WHERE id=? AND company_id=?').get(id, tenant(req));
  if (!i) throw notFound('Interview not found');
  return i as any;
}
export const isParticipant = (interviewId: string, userId: string) => !!db.prepare('SELECT 1 FROM interview_participants WHERE interview_id=? AND user_id=?').get(interviewId, userId);

interviewRouter.get('/interviews/:id', requirePerm('interviews.read'), wrap((req, res) => {
  const i = getInterview(req);
  const cand = candidateOf(tenant(req), i.application_id);
  const participants = db.prepare('SELECT u.id,u.name,u.email,p.role FROM interview_participants p JOIN users u ON u.id=p.user_id WHERE p.interview_id=?').all(i.id);
  const role = req.auth!.role ?? undefined;
  const mayJoin = isParticipant(i.id, req.auth!.userId) || ['owner', 'admin'].includes(role || '');
  const recordings = can(role, 'recordings.view') ? db.prepare('SELECT id,source,status,size,created_at,completed_at FROM interview_recordings WHERE interview_id=? AND company_id=? ORDER BY created_at').all(i.id, tenant(req)) : [];
  res.json({ ...i, config: j(i.config, {}), candidate: cand, participants, mayJoin, recordings });
}));

interviewRouter.patch('/interviews/:id', requirePerm('interviews.schedule'), wrap((req, res) => {
  const i = getInterview(req);
  if (['completed', 'cancelled'].includes(i.status)) throw bad('This interview can no longer be changed');
  const b = parse(body.pick({ title: true, scheduledAt: true, durationMin: true, timezone: true, instructions: true, interviewerIds: true, config: true }).partial(), req.body);
  const cid = tenant(req);
  const resched = !!b.scheduledAt && b.scheduledAt !== i.scheduled_at;
  const cfg = b.config ? { ...j(i.config, {}), ...b.config } : j(i.config, {});
  db.transaction(() => {
    db.prepare('UPDATE interviews SET title=?, scheduled_at=?, duration_min=?, timezone=?, instructions=?, config=? WHERE id=? AND company_id=?')
      .run(b.title ?? i.title, b.scheduledAt ?? i.scheduled_at, b.durationMin ?? i.duration_min, b.timezone ?? i.timezone, b.instructions === undefined ? i.instructions : b.instructions, JSON.stringify(cfg), i.id, cid);
    if (b.interviewerIds) {
      for (const u of b.interviewerIds) if (!db.prepare("SELECT 1 FROM company_members WHERE company_id=? AND user_id=? AND status='active'").get(cid, u)) throw bad('An interviewer is not on your team');
      db.prepare('DELETE FROM interview_participants WHERE interview_id=? AND company_id=?').run(i.id, cid);
      b.interviewerIds.forEach((u, idx) => db.prepare('INSERT INTO interview_participants(id,company_id,interview_id,user_id,role) VALUES (?,?,?,?,?)').run(uid(), cid, i.id, u, idx === 0 ? 'lead' : 'interviewer'));
    }
  })();
  if (resched) {
    const link = sendInvite(cid, i.id, 'reschedule');
    const ps = db.prepare('SELECT user_id FROM interview_participants WHERE interview_id=?').all(i.id) as any[];
    ps.forEach(p => notify(cid, p.user_id, 'interview', `Interview rescheduled: ${i.title}`, new Date(b.scheduledAt!).toUTCString(), `/interviews/${i.id}`, { email: true }));
    return res.json({ ok: true, ...(config.isProd ? {} : { devInviteUrl: link }) });
  }
  res.json({ ok: true });
}));

interviewRouter.post('/interviews/:id/cancel', requirePerm('interviews.schedule'), wrap((req, res) => {
  const i = getInterview(req);
  if (['completed', 'cancelled'].includes(i.status)) throw bad('Already finished');
  db.prepare("UPDATE interviews SET status='cancelled' WHERE id=?").run(i.id);
  db.prepare('UPDATE interview_invitations SET revoked_at=? WHERE interview_id=? AND revoked_at IS NULL').run(now(), i.id);
  sendInvite(tenant(req), i.id, 'cancel');
  (db.prepare('SELECT user_id FROM interview_participants WHERE interview_id=?').all(i.id) as any[]).forEach(p => notify(tenant(req), p.user_id, 'interview', `Interview cancelled: ${i.title}`, undefined, `/interviews/${i.id}`, { email: true }));
  audit(tenant(req), req.auth!, 'interview.cancelled', i.id, req);
  res.json({ ok: true });
}));

interviewRouter.post('/interviews/:id/resend-invite', requirePerm('interviews.schedule'), wrap((req, res) => {
  const i = getInterview(req);
  if (['completed', 'cancelled'].includes(i.status)) throw bad('Interview is closed');
  const link = sendInvite(tenant(req), i.id, 'reminder');
  res.json({ ok: true, ...(config.isProd ? {} : { devInviteUrl: link }) });
}));

interviewRouter.post('/interviews/:id/revoke-invite', requirePerm('interviews.schedule'), wrap((req, res) => {
  const i = getInterview(req);
  db.prepare('UPDATE interview_invitations SET revoked_at=? WHERE interview_id=? AND company_id=? AND revoked_at IS NULL').run(now(), i.id, tenant(req));
  audit(tenant(req), req.auth!, 'invite.revoked', i.id, req);
  res.json({ ok: true });
}));

/** Authorised staff: obtain a one-time realtime ticket for the room. */
interviewRouter.post('/interviews/:id/room-ticket', requirePerm('interviews.read'), wrap((req, res) => {
  const i = getInterview(req);
  const role = req.auth!.role!;
  if (!isParticipant(i.id, req.auth!.userId) && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'You are not an interviewer on this interview');
  if (['cancelled'].includes(i.status)) throw bad('This interview was cancelled');
  const ticket = createRoomTicket({ interviewId: i.id, companyId: tenant(req), kind: 'staff', userId: req.auth!.userId, name: req.auth!.name, role: isParticipant(i.id, req.auth!.userId) ? 'interviewer' : 'observer' });
  res.json({ ticket, iceServers: config.iceServers, interview: { id: i.id, title: i.title, config: j(i.config, {}), durationMin: i.duration_min, scheduledAt: i.scheduled_at, status: i.status } });
}));

/* ---------- secondary camera (QR) ---------- */
interviewRouter.post('/interviews/:id/camera-qr', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const i = getInterview(req);
  const cfg = j(i.config, {} as any);
  if (!cfg.secondaryCamera) throw bad('Secondary camera is not enabled for this interview');
  enforce(tenant(req), { feature: 'secondary_camera' });
  db.prepare('UPDATE camera_sessions SET ended_at=? WHERE interview_id=? AND ended_at IS NULL').run(now(), i.id);
  const raw = newToken(24);
  db.prepare('INSERT INTO camera_sessions(id,company_id,interview_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(uid(), tenant(req), i.id, sha256(raw), addMinutes(10), now());
  const url = `${config.appUrl}/camera/${raw}`;
  res.json({ url, expiresInSec: 600, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }) });
}));

/* ---------- recordings ---------- */
interviewRouter.get('/interviews/:id/playback', requirePerm('recordings.view'), wrap((req, res) => {
  const i = getInterview(req);
  const role = req.auth!.role!;
  if (!isParticipant(i.id, req.auth!.userId) && !['owner', 'admin', 'hiring_manager'].includes(role)) throw new HttpError(403, 'Recording access is limited to interview participants and hiring managers');
  const recs = (db.prepare("SELECT id,source,size,created_at,completed_at FROM interview_recordings WHERE interview_id=? AND company_id=? AND status='ready'").all(i.id, tenant(req)) as any[])
    .map(r => ({ ...r, url: `/api/files/${signFileToken({ k: 'recording', id: r.id, cid: tenant(req), uid: req.auth!.userId }, 900)}` }));
  const events = db.prepare('SELECT id,kind,label,offset_sec,created_at FROM recording_events WHERE interview_id=? AND company_id=? ORDER BY offset_sec').all(i.id, tenant(req));
  const snaps = db.prepare('SELECT id,file_name,language,created_at,substr(content,1,0) x FROM code_snapshots WHERE interview_id=? AND company_id=? ORDER BY created_at').all(i.id, tenant(req));
  const transcript = db.prepare('SELECT speaker,text,offset_sec FROM interview_transcripts WHERE interview_id=? AND company_id=? ORDER BY offset_sec').all(i.id, tenant(req));
  audit(tenant(req), req.auth!, 'recording.accessed', i.id, req);
  res.json({ interview: { id: i.id, title: i.title, started_at: i.started_at, ended_at: i.ended_at }, recordings: recs, events, snapshots: snaps, transcript });
}));
interviewRouter.get('/interviews/:id/snapshots/:sid', requirePerm('recordings.view'), wrap((req, res) => {
  const i = getInterview(req);
  const s = db.prepare('SELECT * FROM code_snapshots WHERE id=? AND interview_id=? AND company_id=?').get(req.params.sid, i.id, tenant(req));
  if (!s) throw notFound();
  res.json(s);
}));
interviewRouter.post('/interviews/:id/bookmarks', requirePerm('interviews.conduct'), wrap((req, res) => {
  const i = getInterview(req);
  const b = parse(z.object({ label: z.string().trim().min(1).max(300), offsetSec: z.number().min(0).max(86400 * 2), kind: z.enum(['bookmark', 'note']).default('bookmark') }), req.body);
  db.prepare('INSERT INTO recording_events(id,company_id,interview_id,kind,label,offset_sec,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid(), tenant(req), i.id, b.kind, b.label, b.offsetSec, req.auth!.userId, now());
  res.status(201).json({ ok: true });
}));
interviewRouter.delete('/recordings/:rid', requirePerm('recordings.delete'), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM interview_recordings WHERE id=? AND company_id=?').get(req.params.rid, tenant(req)) as any;
  if (!r) throw notFound();
  const { deleteFile } = await import('../services.js');
  deleteFile(r.file_key);
  db.prepare("UPDATE interview_recordings SET status='deleted', file_key=NULL WHERE id=?").run(r.id);
  audit(tenant(req), req.auth!, 'recording.deleted', r.id, req);
  res.json({ ok: true });
}));
export { isExpired };

/** An existing participant (or admin) can add another authorised team member mid-session. */
interviewRouter.post('/interviews/:id/participants', requirePerm('interviews.conduct'), wrap((req, res) => {
  const i = getInterview(req);
  if (!isParticipant(i.id, req.auth!.userId) && !['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Only participants can add others');
  if (['completed', 'cancelled'].includes(i.status)) throw bad('Interview is closed');
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const m = db.prepare("SELECT role FROM company_members WHERE company_id=? AND user_id=? AND status='active'").get(tenant(req), userId) as any;
  if (!m) throw bad('That person is not on your team');
  if (!can(m.role, 'interviews.conduct')) throw bad('That role cannot take part in interviews');
  db.prepare("INSERT OR IGNORE INTO interview_participants(id,company_id,interview_id,user_id,role) VALUES (?,?,?,?,'interviewer')").run(uid(), tenant(req), i.id, userId);
  notify(tenant(req), userId, 'interview', `You were added to: ${i.title}`, undefined, `/interviews/${i.id}/room`, { email: false });
  audit(tenant(req), req.auth!, 'interview.participant_added', i.id, req, { userId });
  res.json({ ok: true });
}));
