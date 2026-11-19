import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
import { requirePerm, tenant, can } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound, arr } from '../util.js';
import { audit, logActivity, saveFile, scanFile, deleteFile, signFileToken, verifyFileToken, safeKey, notify } from '../services.js';
import { extractText, parseJD, parseResume, matchScore, findSkills } from '../parsing.js';

export const recruitRouter = Router();
export const filesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const stagesOf = (companyId: string): string[] => {
  const c = db.prepare('SELECT settings FROM companies WHERE id=?').get(companyId) as any;
  return j<any>(c.settings, {}).hiringStages || ['Applied'];
};

/* =============== JOBS =============== */
const jobBody = z.object({
  title: z.string().trim().min(2).max(120), department: z.string().max(80).nullish(), location: z.string().max(120).nullish(),
  employment_type: z.string().max(30).nullish(), exp_min: z.number().int().min(0).max(60).nullish(), exp_max: z.number().int().min(0).max(60).nullish(),
  description: z.string().max(30000).nullish(), responsibilities: z.string().max(10000).nullish(), qualifications: z.string().max(10000).nullish(),
  required_skills: z.array(z.string().max(40)).max(50).default([]), preferred_skills: z.array(z.string().max(40)).max(50).default([]),
  screening_questions: z.array(z.string().max(300)).max(20).default([]), interviewer_ids: z.array(z.string()).max(20).default([]),
  recruiter_id: z.string().nullish(), is_template: z.boolean().default(false),
});
const jobOut = (r: any) => ({ ...r, required_skills: j(r.required_skills, []), preferred_skills: j(r.preferred_skills, []), screening_questions: j(r.screening_questions, []), interviewer_ids: j(r.interviewer_ids, []), is_template: !!r.is_template });

function validateInterviewers(companyId: string, ids: string[]) {
  for (const id of ids) {
    if (!db.prepare("SELECT 1 FROM company_members WHERE company_id=? AND user_id=? AND status='active'").get(companyId, id)) throw bad('Interviewer is not on your team');
  }
}

recruitRouter.get('/jobs', requirePerm('jobs.read'), wrap((req, res) => {
  const { status, q, templates } = req.query as Record<string, string | undefined>;
  let sql = `SELECT jobs.*, (SELECT COUNT(*) FROM applications a WHERE a.job_id=jobs.id AND a.company_id=jobs.company_id) applicants FROM jobs WHERE company_id=? AND is_template=?`;
  const args: any[] = [tenant(req), templates ? 1 : 0];
  if (status) { sql += ' AND status=?'; args.push(status); }
  if (q) { sql += ' AND (title LIKE ? OR department LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  res.json({ items: (db.prepare(sql + ' ORDER BY updated_at DESC LIMIT 200').all(...args) as any[]).map(jobOut) });
}));

recruitRouter.post('/jobs/parse', requirePerm('jobs.write'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Attach a file');
  await scanFile(req.file.buffer);
  const { text } = await extractText(req.file.buffer);
  if (text.trim().length < 20) throw new HttpError(422, 'No readable text found in this file', 'empty_doc');
  res.json({ parsed: parseJD(text), note: 'Fields are extracted automatically. Please review before saving.' });
}));

recruitRouter.post('/jobs', requirePerm('jobs.write'), wrap((req, res) => {
  const b = parse(jobBody, req.body);
  validateInterviewers(tenant(req), b.interviewer_ids);
  const id = uid(), t = now();
  db.prepare(`INSERT INTO jobs(id,company_id,title,department,location,employment_type,exp_min,exp_max,description,responsibilities,qualifications,required_skills,preferred_skills,screening_questions,status,is_template,recruiter_id,interviewer_ids,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)`).run(id, tenant(req), b.title, b.department ?? null, b.location ?? null, b.employment_type ?? null, b.exp_min ?? null, b.exp_max ?? null,
    b.description ?? null, b.responsibilities ?? null, b.qualifications ?? null, JSON.stringify(b.required_skills), JSON.stringify(b.preferred_skills), JSON.stringify(b.screening_questions),
    +b.is_template, b.recruiter_id ?? req.auth!.userId, JSON.stringify(b.interviewer_ids), req.auth!.userId, t, t);
  audit(tenant(req), req.auth!, 'job.created', id, req);
  res.status(201).json(jobOut(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)));
}));

function getJob(req: any) {
  const r = db.prepare('SELECT * FROM jobs WHERE id=? AND company_id=?').get(req.params.id, tenant(req));
  if (!r) throw notFound('Job not found');
  return r as any;
}

recruitRouter.get('/jobs/:id', requirePerm('jobs.read'), wrap((req, res) => res.json(jobOut(getJob(req)))));

recruitRouter.patch('/jobs/:id', requirePerm('jobs.write'), wrap((req, res) => {
  const cur = getJob(req);
  const b = parse(jobBody.partial(), req.body);
  if (b.interviewer_ids) validateInterviewers(tenant(req), b.interviewer_ids);
  const m: any = { ...jobOut(cur), ...b };
  db.prepare(`UPDATE jobs SET title=?,department=?,location=?,employment_type=?,exp_min=?,exp_max=?,description=?,responsibilities=?,qualifications=?,required_skills=?,preferred_skills=?,screening_questions=?,recruiter_id=?,interviewer_ids=?,updated_at=? WHERE id=? AND company_id=?`)
    .run(m.title, m.department ?? null, m.location ?? null, m.employment_type ?? null, m.exp_min ?? null, m.exp_max ?? null, m.description ?? null, m.responsibilities ?? null, m.qualifications ?? null,
      JSON.stringify(m.required_skills), JSON.stringify(m.preferred_skills), JSON.stringify(m.screening_questions), m.recruiter_id ?? null, JSON.stringify(m.interviewer_ids), now(), cur.id, tenant(req));
  audit(tenant(req), req.auth!, 'job.updated', cur.id, req);
  res.json(jobOut(db.prepare('SELECT * FROM jobs WHERE id=?').get(cur.id)));
}));

recruitRouter.post('/jobs/:id/status', requirePerm('jobs.write'), wrap((req, res) => {
  const { status } = parse(z.object({ status: z.enum(['draft', 'published', 'archived']) }), req.body);
  const cur = getJob(req);
  db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(status, now(), cur.id);
  audit(tenant(req), req.auth!, `job.${status}`, cur.id, req);
  res.json({ ok: true });
}));

recruitRouter.post('/jobs/:id/duplicate', requirePerm('jobs.write'), wrap((req, res) => {
  const cur = getJob(req);
  const { asTemplate } = parse(z.object({ asTemplate: z.boolean().default(false) }), req.body ?? {});
  const id = uid(), t = now();
  db.prepare(`INSERT INTO jobs(id,company_id,title,department,location,employment_type,exp_min,exp_max,description,responsibilities,qualifications,required_skills,preferred_skills,screening_questions,status,is_template,recruiter_id,interviewer_ids,created_by,created_at,updated_at)
    SELECT ?,company_id,?,department,location,employment_type,exp_min,exp_max,description,responsibilities,qualifications,required_skills,preferred_skills,screening_questions,'draft',?,recruiter_id,interviewer_ids,?,?,? FROM jobs WHERE id=?`)
    .run(id, asTemplate ? cur.title : `${cur.title} (copy)`, +asTemplate, req.auth!.userId, t, t, cur.id);
  res.status(201).json(jobOut(db.prepare('SELECT * FROM jobs WHERE id=?').get(id)));
}));

recruitRouter.delete('/jobs/:id', requirePerm('jobs.write'), wrap((req, res) => {
  const cur = getJob(req);
  const n = (db.prepare('SELECT COUNT(*) c FROM applications WHERE job_id=? AND company_id=?').get(cur.id, tenant(req)) as any).c;
  if (n > 0) throw new HttpError(409, 'This job has applicants. Archive it instead of deleting.', 'has_applicants');
  db.prepare('DELETE FROM jobs WHERE id=? AND company_id=?').run(cur.id, tenant(req));
  audit(tenant(req), req.auth!, 'job.deleted', cur.id, req);
  res.json({ ok: true });
}));

recruitRouter.get('/jobs/:id/pipeline', requirePerm('jobs.read'), wrap((req, res) => {
  const job = getJob(req);
  const rows = db.prepare(`SELECT a.id, a.stage, a.match_score, a.decision, a.updated_at, c.id candidate_id, c.name, c.email, c.current_title, c.skills, c.tags
    FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.job_id=? AND a.company_id=? ORDER BY a.updated_at DESC`).all(job.id, tenant(req)) as any[];
  res.json({ stages: stagesOf(tenant(req)), items: rows.map(r => ({ ...r, skills: j(r.skills, []), tags: j(r.tags, []) })) });
}));

/* =============== CANDIDATES =============== */
const candBody = z.object({
  name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(), phone: z.string().max(30).nullish(),
  current_title: z.string().max(120).nullish(), current_company: z.string().max(120).nullish(), location: z.string().max(120).nullish(),
  experience_years: z.number().min(0).max(60).nullish(), skills: z.array(z.string().max(40)).max(60).default([]), tags: z.array(z.string().max(30)).max(20).default([]),
  source: z.string().max(60).nullish(), jobId: z.string().nullish(),
});
const candOut = (r: any) => ({ ...r, skills: j(r.skills, []), tags: j(r.tags, []) });

function createApplication(companyId: string, jobId: string, candidateId: string, actor: string) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND company_id=?').get(jobId, companyId) as any;
  if (!job) throw notFound('Job not found');
  const cand = db.prepare('SELECT * FROM candidates WHERE id=? AND company_id=?').get(candidateId, companyId) as any;
  const existing = db.prepare('SELECT id FROM applications WHERE job_id=? AND candidate_id=?').get(jobId, candidateId) as any;
  if (existing) return existing.id as string;
  const mm = matchScore({ required_skills: j(job.required_skills, []), preferred_skills: j(job.preferred_skills, []), exp_min: job.exp_min }, { skills: j(cand.skills, []), experience_years: cand.experience_years });
  const id = uid(), t = now();
  db.prepare('INSERT INTO applications(id,company_id,job_id,candidate_id,stage,match_score,match_detail,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, companyId, jobId, candidateId, stagesOf(companyId)[0], mm.score, JSON.stringify(mm.detail), t, t);
  logActivity(companyId, { applicationId: id, candidateId, actorId: actor, action: 'application.created', detail: `Applied to ${job.title}` });
  return id;
}

recruitRouter.get('/candidates', requirePerm('candidates.read'), wrap((req, res) => {
  const { q, skill, tag, jobId, stage } = req.query as Record<string, string | undefined>;
  let sql = `SELECT c.*, (SELECT COUNT(*) FROM applications a WHERE a.candidate_id=c.id) applications FROM candidates c WHERE c.company_id=?`;
  const args: any[] = [tenant(req)];
  if (q) { sql += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.current_title LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (skill) { sql += ' AND c.skills LIKE ?'; args.push(`%"${skill.toLowerCase().replace(/[%"]/g, '')}"%`); }
  if (tag) { sql += ' AND c.tags LIKE ?'; args.push(`%"${tag.replace(/[%"]/g, '')}"%`); }
  if (jobId || stage) {
    sql += ' AND EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=c.id AND a.company_id=c.company_id' + (jobId ? ' AND a.job_id=?' : '') + (stage ? ' AND a.stage=?' : '') + ')';
    if (jobId) args.push(jobId); if (stage) args.push(stage);
  }
  res.json({ items: (db.prepare(sql + ' ORDER BY c.created_at DESC LIMIT 300').all(...args) as any[]).map(candOut) });
}));

recruitRouter.post('/candidates', requirePerm('candidates.write'), wrap((req, res) => {
  const b = parse(candBody, req.body);
  if (db.prepare('SELECT 1 FROM candidates WHERE company_id=? AND email=?').get(tenant(req), b.email)) throw new HttpError(409, 'A candidate with this email already exists', 'duplicate');
  const id = uid();
  db.transaction(() => {
    db.prepare(`INSERT INTO candidates(id,company_id,name,email,phone,current_title,current_company,location,experience_years,skills,tags,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tenant(req), b.name, b.email, b.phone ?? null, b.current_title ?? null, b.current_company ?? null, b.location ?? null, b.experience_years ?? null,
        JSON.stringify(b.skills.map(s => s.toLowerCase())), JSON.stringify(b.tags), b.source ?? 'manual', req.auth!.userId, now());
    if (b.jobId) createApplication(tenant(req), b.jobId, id, req.auth!.userId);
  })();
  audit(tenant(req), req.auth!, 'candidate.created', id, req);
  res.status(201).json(candOut(db.prepare('SELECT * FROM candidates WHERE id=?').get(id)));
}));

recruitRouter.post('/candidates/import', requirePerm('candidates.write'), wrap((req, res) => {
  const { rows, jobId } = parse(z.object({ rows: z.array(z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().optional(), current_title: z.string().optional(), skills: z.string().optional() })).min(1).max(500), jobId: z.string().nullish() }), req.body);
  let created = 0; const skipped: string[] = [];
  db.transaction(() => {
    for (const r of rows) {
      const email = r.email.toLowerCase();
      if (db.prepare('SELECT 1 FROM candidates WHERE company_id=? AND email=?').get(tenant(req), email)) { skipped.push(email); continue; }
      const id = uid();
      db.prepare('INSERT INTO candidates(id,company_id,name,email,phone,current_title,skills,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, tenant(req), r.name, email, r.phone ?? null, r.current_title ?? null, JSON.stringify((r.skills || '').split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean)), 'import', req.auth!.userId, now());
      if (jobId) createApplication(tenant(req), jobId, id, req.auth!.userId);
      created++;
    }
  })();
  audit(tenant(req), req.auth!, 'candidate.imported', String(created), req);
  res.json({ created, skipped });
}));

function getCand(req: any) {
  const c = db.prepare('SELECT * FROM candidates WHERE id=? AND company_id=?').get(req.params.id, tenant(req));
  if (!c) throw notFound('Candidate not found');
  return c as any;
}

recruitRouter.get('/candidates/:id', requirePerm('candidates.read'), wrap((req, res) => {
  const c = getCand(req); const cid = tenant(req);
  const resumes = db.prepare('SELECT id,original_name,mime,size,uploaded_at FROM candidate_resumes WHERE candidate_id=? AND company_id=? ORDER BY uploaded_at DESC').all(c.id, cid);
  const applications = (db.prepare(`SELECT a.*, jb.title job_title FROM applications a JOIN jobs jb ON jb.id=a.job_id WHERE a.candidate_id=? AND a.company_id=? ORDER BY a.created_at DESC`).all(c.id, cid) as any[])
    .map(a => ({ ...a, match_detail: j(a.match_detail, null) }));
  const interviews = db.prepare(`SELECT i.id,i.title,i.round_no,i.type,i.scheduled_at,i.status,i.application_id FROM interviews i JOIN applications a ON a.id=i.application_id WHERE a.candidate_id=? AND i.company_id=? ORDER BY i.scheduled_at DESC`).all(c.id, cid) as any[];
  const coding = db.prepare(`SELECT s.id,s.interview_id,s.language,s.kind,s.passed,s.total,s.score,s.created_at FROM coding_submissions s JOIN interviews i ON i.id=s.interview_id JOIN applications a ON a.id=i.application_id
    WHERE a.candidate_id=? AND s.company_id=? AND s.kind='submit' ORDER BY s.created_at DESC LIMIT 20`).all(c.id, cid);
  const canFb = can(req.auth!.role ?? undefined, 'feedback.viewAll');
  const feedback = canFb ? db.prepare(`SELECT f.interview_id, f.recommendation, f.evidence, f.ratings, u.name interviewer FROM interview_feedback f JOIN interviews i ON i.id=f.interview_id
    JOIN applications a ON a.id=i.application_id JOIN users u ON u.id=f.interviewer_id WHERE a.candidate_id=? AND f.company_id=? AND f.submitted=1`).all(c.id, cid) : [];
  const recordings = can(req.auth!.role ?? undefined, 'recordings.view')
    ? db.prepare(`SELECT r.id, r.interview_id, r.source, r.status, r.created_at FROM interview_recordings r JOIN interviews i ON i.id=r.interview_id JOIN applications a ON a.id=i.application_id WHERE a.candidate_id=? AND r.company_id=? AND r.status='ready'`).all(c.id, cid) : [];
  const activity = db.prepare('SELECT action,detail,created_at FROM activity WHERE candidate_id=? AND company_id=? ORDER BY created_at DESC LIMIT 50').all(c.id, cid);
  res.json({ candidate: candOut(c), resumes, applications, interviews, coding, feedback: (feedback as any[]).map(f => ({ ...f, ratings: j(f.ratings, {}) })), recordings, activity });
}));

recruitRouter.patch('/candidates/:id', requirePerm('candidates.write'), wrap((req, res) => {
  const c = getCand(req);
  const b = parse(candBody.partial().omit({ jobId: true, email: true }), req.body);
  const m: any = { ...candOut(c), ...b };
  db.prepare('UPDATE candidates SET name=?,phone=?,current_title=?,current_company=?,location=?,experience_years=?,skills=?,tags=?,source=? WHERE id=? AND company_id=?')
    .run(m.name, m.phone ?? null, m.current_title ?? null, m.current_company ?? null, m.location ?? null, m.experience_years ?? null, JSON.stringify((m.skills as string[]).map(s => s.toLowerCase())), JSON.stringify(m.tags), m.source ?? null, c.id, tenant(req));
  res.json(candOut(db.prepare('SELECT * FROM candidates WHERE id=?').get(c.id)));
}));

/** Data-subject deletion workflow: removes candidate, resumes, applications, interviews and recordings. */
recruitRouter.delete('/candidates/:id', requirePerm('candidates.write'), wrap((req, res) => {
  const c = getCand(req); const cid = tenant(req);
  if (!['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Only owners/admins can permanently delete candidate data');
  const files = [
    ...(db.prepare('SELECT file_key FROM candidate_resumes WHERE candidate_id=? AND company_id=?').all(c.id, cid) as any[]),
    ...(db.prepare(`SELECT r.file_key FROM interview_recordings r JOIN interviews i ON i.id=r.interview_id JOIN applications a ON a.id=i.application_id WHERE a.candidate_id=? AND r.company_id=?`).all(c.id, cid) as any[]),
  ];
  db.transaction(() => {
    db.prepare('DELETE FROM activity WHERE candidate_id=? AND company_id=?').run(c.id, cid);
    db.prepare('DELETE FROM candidates WHERE id=? AND company_id=?').run(c.id, cid); // cascades
  })();
  files.forEach(f => deleteFile(f.file_key));
  audit(cid, req.auth!, 'candidate.deleted', c.id, req, { reason: 'erasure' });
  res.json({ ok: true });
}));

recruitRouter.post('/candidates/:id/resume', requirePerm('candidates.write'), upload.single('file'), wrap(async (req, res) => {
  const c = getCand(req);
  if (!req.file) throw bad('Attach a file');
  await scanFile(req.file.buffer);
  const { text, type } = await extractText(req.file.buffer);
  if (type === 'txt' && !/\.txt$/i.test(req.file.originalname)) throw new HttpError(415, 'Unsupported file type');
  const key = saveFile(tenant(req), req.file.buffer, '.' + type);
  const parsed = parseResume(text);
  db.prepare('INSERT INTO candidate_resumes(id,company_id,candidate_id,file_key,original_name,mime,size,parsed_text,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), tenant(req), c.id, key, path.basename(req.file.originalname).slice(0, 120), type, req.file.size, text.slice(0, 60000), now());
  const skills = [...new Set([...j<string[]>(c.skills, []), ...parsed.skills])];
  db.prepare('UPDATE candidates SET skills=?, experience_years=COALESCE(experience_years, ?), phone=COALESCE(phone, ?) WHERE id=?').run(JSON.stringify(skills), parsed.experience_years ?? null, parsed.phone ?? null, c.id);
  // refresh match scores for this candidate's applications
  for (const a of db.prepare('SELECT a.id, jb.required_skills, jb.preferred_skills, jb.exp_min FROM applications a JOIN jobs jb ON jb.id=a.job_id WHERE a.candidate_id=? AND a.company_id=?').all(c.id, tenant(req)) as any[]) {
    const mm = matchScore({ required_skills: j(a.required_skills, []), preferred_skills: j(a.preferred_skills, []), exp_min: a.exp_min }, { skills, experience_years: parsed.experience_years ?? c.experience_years });
    db.prepare('UPDATE applications SET match_score=?, match_detail=? WHERE id=?').run(mm.score, JSON.stringify(mm.detail), a.id);
  }
  logActivity(tenant(req), { candidateId: c.id, actorId: req.auth!.userId, action: 'resume.uploaded', detail: req.file.originalname });
  res.status(201).json({ ok: true, extractedSkills: parsed.skills });
}));

/** Public "parse a resume to prefill the add-candidate form" helper (nothing is stored). */
recruitRouter.post('/candidates/parse-resume', requirePerm('candidates.write'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Attach a file');
  await scanFile(req.file.buffer);
  const { text } = await extractText(req.file.buffer);
  res.json({ parsed: parseResume(text) });
}));

recruitRouter.post('/candidates/:id/resumes/:rid/link', requirePerm('candidates.read'), wrap((req, res) => {
  const r = db.prepare('SELECT id FROM candidate_resumes WHERE id=? AND candidate_id=? AND company_id=?').get(req.params.rid, req.params.id, tenant(req));
  if (!r) throw notFound();
  audit(tenant(req), req.auth!, 'resume.accessed', String(req.params.rid), req);
  res.json({ url: `/api/files/${signFileToken({ k: 'resume', id: String(req.params.rid), cid: tenant(req), uid: req.auth!.userId }, 120)}` });
}));

/* =============== APPLICATIONS =============== */
recruitRouter.post('/candidates/:id/applications', requirePerm('candidates.write'), wrap((req, res) => {
  const c = getCand(req);
  const { jobId } = parse(z.object({ jobId: z.string() }), req.body);
  res.status(201).json({ id: createApplication(tenant(req), jobId, c.id, req.auth!.userId) });
}));

function getApp(req: any) {
  const a = db.prepare('SELECT * FROM applications WHERE id=? AND company_id=?').get(req.params.id, tenant(req));
  if (!a) throw notFound('Application not found');
  return a as any;
}

recruitRouter.patch('/applications/:id/stage', requirePerm('candidates.write'), wrap((req, res) => {
  const a = getApp(req);
  const { stage } = parse(z.object({ stage: z.string() }), req.body);
  if (!stagesOf(tenant(req)).includes(stage)) throw bad('Unknown stage');
  if (['Selected', 'Rejected'].includes(stage) && !can(req.auth!.role ?? undefined, 'decision.make'))
    throw new HttpError(403, 'Final hiring decisions must be made by a hiring manager or admin (human review required).', 'human_review_required');
  db.prepare('UPDATE applications SET stage=?, updated_at=? WHERE id=?').run(stage, now(), a.id);
  logActivity(tenant(req), { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'stage.changed', detail: `${a.stage} → ${stage}` });
  res.json({ ok: true });
}));

recruitRouter.post('/applications/:id/decision', requirePerm('decision.make'), wrap((req, res) => {
  const a = getApp(req);
  const b = parse(z.object({ decision: z.enum(['selected', 'rejected', 'on_hold']), note: z.string().max(2000).default('') }), req.body);
  const stage = { selected: 'Selected', rejected: 'Rejected', on_hold: 'On Hold' }[b.decision];
  db.prepare('UPDATE applications SET decision=?, decision_by=?, decision_note=?, stage=?, updated_at=? WHERE id=?').run(b.decision, req.auth!.userId, b.note, stage, now(), a.id);
  logActivity(tenant(req), { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'decision.made', detail: `${b.decision}${b.note ? ': ' + b.note : ''}` });
  audit(tenant(req), req.auth!, 'application.decision', a.id, req, b);
  res.json({ ok: true });
}));

recruitRouter.get('/applications/:id/notes', requirePerm('candidates.read'), wrap((req, res) => {
  const a = getApp(req);
  res.json({ items: db.prepare('SELECT n.id,n.body,n.created_at,u.name author FROM application_notes n JOIN users u ON u.id=n.author_id WHERE n.application_id=? AND n.company_id=? ORDER BY n.created_at DESC').all(a.id, tenant(req)) });
}));
recruitRouter.post('/applications/:id/notes', requirePerm('candidates.read'), wrap((req, res) => {
  const a = getApp(req);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  db.prepare('INSERT INTO application_notes(id,company_id,application_id,author_id,body,created_at) VALUES (?,?,?,?,?,?)').run(uid(), tenant(req), a.id, req.auth!.userId, body, now());
  logActivity(tenant(req), { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'note.added' });
  res.status(201).json({ ok: true });
}));

recruitRouter.post('/applications/:id/rematch', requirePerm('candidates.write'), wrap((req, res) => {
  const a = getApp(req);
  const jb = db.prepare('SELECT * FROM jobs WHERE id=?').get(a.job_id) as any, c = db.prepare('SELECT * FROM candidates WHERE id=?').get(a.candidate_id) as any;
  const mm = matchScore({ required_skills: j(jb.required_skills, []), preferred_skills: j(jb.preferred_skills, []), exp_min: jb.exp_min }, { skills: j(c.skills, []), experience_years: c.experience_years });
  db.prepare('UPDATE applications SET match_score=?, match_detail=? WHERE id=?').run(mm.score, JSON.stringify(mm.detail), a.id);
  res.json({ score: mm.score, detail: mm.detail });
}));

/* =============== signed file download =============== */
filesRouter.get('/:token', wrap((req, res) => {
  const t = verifyFileToken(String(req.params.token));
  let key: string | null = null, mime = 'application/octet-stream', name = 'file';
  if (t.k === 'resume') {
    const r = db.prepare('SELECT * FROM candidate_resumes WHERE id=? AND company_id=?').get(t.id, t.cid) as any;
    if (r) { key = r.file_key; name = r.original_name; mime = ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', txt: 'text/plain' } as any)[r.mime] || mime; }
  } else if (t.k === 'recording') {
    const r = db.prepare('SELECT * FROM interview_recordings WHERE id=? AND company_id=?').get(t.id, t.cid) as any;
    if (r) { key = r.file_key; mime = r.mime || 'video/webm'; name = `recording-${r.id}.webm`; }
  }
  if (!key) throw notFound();
  const full = safeKey(key);
  if (!fs.existsSync(full)) throw notFound('File no longer available');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', t.k === 'recording' ? 'inline' : `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(full); // supports Range requests for media seeking
}));
export { arr, findSkills, notify };

recruitRouter.get('/applications/:id', requirePerm('candidates.read'), wrap((req, res) => {
  const a = db.prepare(`SELECT a.id, a.stage, a.job_id, jb.title job_title, jb.interviewer_ids, c.id candidate_id, c.name candidate_name, c.email candidate_email
    FROM applications a JOIN jobs jb ON jb.id=a.job_id JOIN candidates c ON c.id=a.candidate_id WHERE a.id=? AND a.company_id=?`).get(req.params.id, tenant(req)) as any;
  if (!a) throw notFound('Application not found');
  res.json({ ...a, interviewer_ids: j(a.interviewer_ids, []) });
}));
