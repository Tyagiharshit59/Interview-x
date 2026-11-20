import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { db, uid, now, j, tx, isDuplicateKey } from '../db.js';
import { requirePerm, tenant, can } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound, arr } from '../util.js';
import { audit, logActivity, saveFile, scanFile, deleteFile, signFileToken, verifyFileToken, safeKey, notify } from '../services.js';
import { extractText, parseJD, parseResume, matchScore, findSkills } from '../parsing.js';

export const recruitRouter = Router();
export const filesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map(k => [k, o[k] === undefined ? null : o[k]]));
const uniq = <T,>(a: T[]) => [...new Set(a)];

const stagesOf = async (companyId: string): Promise<string[]> => {
  const c = await db.companies.get({ id: companyId });
  return j<any>(c?.settings, {}).hiringStages || ['Applied'];
};

/* =============== JOBS =============== */
const jobBody = z.object({
  title: z.string().trim().min(2).max(120), department: z.string().max(80).nullish(), location: z.string().max(120).nullish(),
  employment_type: z.string().max(30).nullish(), exp_min: z.number().int().min(0).max(60).nullish(), exp_max: z.number().int().min(0).max(60).nullish(),
  description: z.string().max(30000).nullish(), responsibilities: z.string().max(10000).nullish(), qualifications: z.string().max(10000).nullish(),
  required_skills: z.array(z.string().max(40)).max(50).default([]), preferred_skills: z.array(z.string().max(40)).max(50).default([]),
  screening_questions: z.array(z.string().max(300)).max(20).default([]), interviewer_ids: z.array(z.string()).max(20).default([]),
  recruiter_id: z.string().nullish(), is_template: z.boolean().default(false),
  public_listing: z.boolean().default(true), // show on the public careers portal once published
});
const jobOut = (r: any) => ({ ...r, public_listing: r.public_listing !== 0, required_skills: j(r.required_skills, []), preferred_skills: j(r.preferred_skills, []), screening_questions: j(r.screening_questions, []), interviewer_ids: j(r.interviewer_ids, []), is_template: !!r.is_template });

async function validateInterviewers(companyId: string, ids: string[]) {
  for (const id of ids) {
    if (!(await db.company_members.exists({ company_id: companyId, user_id: id, status: 'active' }))) throw bad('Interviewer is not on your team');
  }
}

recruitRouter.get('/jobs', requirePerm('jobs.read'), wrap(async (req, res) => {
  const { status, q, templates } = req.query as Record<string, string | undefined>;
  const cid = tenant(req);
  const filter: any = { company_id: cid, is_template: templates ? 1 : 0 };
  if (status) filter.status = status;
  if (q) { const rx = { $regex: escapeRegex(q), $options: 'i' }; filter.$or = [{ title: rx }, { department: rx }]; }
  const rows = await db.jobs.list(filter, { sort: { updated_at: -1 }, limit: 200 });
  const counts = rows.length ? await db.applications.aggregate([
    { $match: { company_id: cid, job_id: { $in: rows.map(r => r.id) } } }, { $group: { _id: '$job_id', n: { $sum: 1 } } },
  ]) : [];
  const byJob = new Map<string, number>(counts.map((c: any) => [c._id, c.n]));
  res.json({ items: rows.map(r => jobOut({ ...r, applicants: byJob.get(r.id) ?? 0 })) });
}));

recruitRouter.post('/jobs/parse', requirePerm('jobs.write'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Attach a file');
  await scanFile(req.file.buffer);
  const { text } = await extractText(req.file.buffer);
  if (text.trim().length < 20) throw new HttpError(422, 'No readable text found in this file', 'empty_doc');
  res.json({ parsed: parseJD(text), note: 'Fields are extracted automatically. Please review before saving.' });
}));

recruitRouter.post('/jobs', requirePerm('jobs.write'), wrap(async (req, res) => {
  const b = parse(jobBody, req.body);
  await validateInterviewers(tenant(req), b.interviewer_ids);
  const t = now();
  const id = await db.jobs.insert({
    company_id: tenant(req), title: b.title, department: b.department ?? null, location: b.location ?? null, employment_type: b.employment_type ?? null,
    exp_min: b.exp_min ?? null, exp_max: b.exp_max ?? null, description: b.description ?? null, responsibilities: b.responsibilities ?? null, qualifications: b.qualifications ?? null,
    required_skills: JSON.stringify(b.required_skills), preferred_skills: JSON.stringify(b.preferred_skills), screening_questions: JSON.stringify(b.screening_questions),
    status: 'draft', is_template: +b.is_template, public_listing: +b.public_listing, recruiter_id: b.recruiter_id ?? req.auth!.userId, interviewer_ids: JSON.stringify(b.interviewer_ids),
    created_by: req.auth!.userId, created_at: t, updated_at: t,
  });
  await audit(tenant(req), req.auth!, 'job.created', id, req);
  res.status(201).json(jobOut(await db.jobs.get({ id })));
}));

async function getJob(req: any) {
  const r = await db.jobs.get({ id: req.params.id, company_id: tenant(req) });
  if (!r) throw notFound('Job not found');
  return r as any;
}

recruitRouter.get('/jobs/:id', requirePerm('jobs.read'), wrap(async (req, res) => res.json(jobOut(await getJob(req)))));

recruitRouter.patch('/jobs/:id', requirePerm('jobs.write'), wrap(async (req, res) => {
  const cur = await getJob(req);
  const b = parse(jobBody.partial(), req.body);
  if (b.interviewer_ids) await validateInterviewers(tenant(req), b.interviewer_ids);
  const m: any = { ...jobOut(cur), ...b };
  await db.jobs.set({ id: cur.id, company_id: tenant(req) }, {
    title: m.title, department: m.department ?? null, location: m.location ?? null, employment_type: m.employment_type ?? null, exp_min: m.exp_min ?? null, exp_max: m.exp_max ?? null,
    description: m.description ?? null, responsibilities: m.responsibilities ?? null, qualifications: m.qualifications ?? null,
    required_skills: JSON.stringify(m.required_skills), preferred_skills: JSON.stringify(m.preferred_skills), screening_questions: JSON.stringify(m.screening_questions),
    recruiter_id: m.recruiter_id ?? null, interviewer_ids: JSON.stringify(m.interviewer_ids), public_listing: m.public_listing === false ? 0 : 1, updated_at: now(),
  });
  await audit(tenant(req), req.auth!, 'job.updated', cur.id, req);
  res.json(jobOut(await db.jobs.get({ id: cur.id })));
}));

recruitRouter.post('/jobs/:id/status', requirePerm('jobs.write'), wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['draft', 'published', 'archived']) }), req.body);
  const cur = await getJob(req);
  await db.jobs.set({ id: cur.id, company_id: tenant(req) }, { status, updated_at: now() });
  await audit(tenant(req), req.auth!, `job.${status}`, cur.id, req);
  res.json({ ok: true });
}));

recruitRouter.post('/jobs/:id/duplicate', requirePerm('jobs.write'), wrap(async (req, res) => {
  const cur = await getJob(req);
  const { asTemplate } = parse(z.object({ asTemplate: z.boolean().default(false) }), req.body ?? {});
  const t = now();
  const id = await db.jobs.insert({
    company_id: cur.company_id, title: asTemplate ? cur.title : `${cur.title} (copy)`, department: cur.department ?? null, location: cur.location ?? null, employment_type: cur.employment_type ?? null,
    exp_min: cur.exp_min ?? null, exp_max: cur.exp_max ?? null, description: cur.description ?? null, responsibilities: cur.responsibilities ?? null, qualifications: cur.qualifications ?? null,
    required_skills: cur.required_skills ?? '[]', preferred_skills: cur.preferred_skills ?? '[]', screening_questions: cur.screening_questions ?? '[]',
    status: 'draft', is_template: +asTemplate, recruiter_id: cur.recruiter_id ?? null, interviewer_ids: cur.interviewer_ids ?? '[]',
    created_by: req.auth!.userId, created_at: t, updated_at: t,
  });
  res.status(201).json(jobOut(await db.jobs.get({ id })));
}));

recruitRouter.delete('/jobs/:id', requirePerm('jobs.write'), wrap(async (req, res) => {
  const cur = await getJob(req);
  const n = await db.applications.count({ job_id: cur.id, company_id: tenant(req) });
  if (n > 0) throw new HttpError(409, 'This job has applicants. Archive it instead of deleting.', 'has_applicants');
  await db.jobs.del({ id: cur.id, company_id: tenant(req) });
  await audit(tenant(req), req.auth!, 'job.deleted', cur.id, req);
  res.json({ ok: true });
}));

recruitRouter.get('/jobs/:id/pipeline', requirePerm('jobs.read'), wrap(async (req, res) => {
  const job = await getJob(req);
  const cid = tenant(req);
  const apps = await db.applications.list({ job_id: job.id, company_id: cid }, { sort: { updated_at: -1 } });
  const cands = apps.length ? await db.candidates.list({ company_id: cid, id: { $in: uniq(apps.map(a => a.candidate_id)) } }) : [];
  const cm = new Map(cands.map(c => [c.id, c]));
  const items = apps.filter(a => cm.has(a.candidate_id)).map(a => {
    const c = cm.get(a.candidate_id);
    return { id: a.id, stage: a.stage, match_score: a.match_score ?? null, decision: a.decision ?? null, updated_at: a.updated_at, candidate_id: c.id, name: c.name, email: c.email, current_title: c.current_title ?? null, skills: j(c.skills, []), tags: j(c.tags, []) };
  });
  res.json({ stages: await stagesOf(cid), items });
}));

/* =============== CANDIDATES =============== */
const candBody = z.object({
  name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(), phone: z.string().max(30).nullish(),
  current_title: z.string().max(120).nullish(), current_company: z.string().max(120).nullish(), location: z.string().max(120).nullish(),
  experience_years: z.number().min(0).max(60).nullish(), skills: z.array(z.string().max(40)).max(60).default([]), tags: z.array(z.string().max(30)).max(20).default([]),
  source: z.string().max(60).nullish(), jobId: z.string().nullish(),
});
const candOut = (r: any) => ({ ...r, skills: j(r.skills, []), tags: j(r.tags, []) });

async function createApplication(companyId: string, jobId: string, candidateId: string, actor: string) {
  const job = await db.jobs.get({ id: jobId, company_id: companyId });
  if (!job) throw notFound('Job not found');
  const cand = await db.candidates.get({ id: candidateId, company_id: companyId });
  if (!cand) throw notFound('Candidate not found');
  const existing = await db.applications.get({ job_id: jobId, candidate_id: candidateId, company_id: companyId });
  if (existing) return existing.id as string;
  const mm = matchScore({ required_skills: j(job.required_skills, []), preferred_skills: j(job.preferred_skills, []), exp_min: job.exp_min }, { skills: j(cand.skills, []), experience_years: cand.experience_years });
  const t = now();
  const id = await db.applications.insert({
    company_id: companyId, job_id: jobId, candidate_id: candidateId, stage: (await stagesOf(companyId))[0], match_score: mm.score, match_detail: JSON.stringify(mm.detail), created_at: t, updated_at: t,
  });
  await logActivity(companyId, { applicationId: id, candidateId, actorId: actor, action: 'application.created', detail: `Applied to ${job.title}` });
  return id;
}

recruitRouter.get('/candidates', requirePerm('candidates.read'), wrap(async (req, res) => {
  const { q, skill, tag, jobId, stage } = req.query as Record<string, string | undefined>;
  const cid = tenant(req);
  const and: any[] = [];
  if (q) { const rx = { $regex: escapeRegex(q), $options: 'i' }; and.push({ $or: [{ name: rx }, { email: rx }, { current_title: rx }] }); }
  if (skill) and.push({ skills: { $regex: escapeRegex(`"${skill.toLowerCase().replace(/[%"]/g, '')}"`), $options: 'i' } });
  if (tag) and.push({ tags: { $regex: escapeRegex(`"${tag.replace(/[%"]/g, '')}"`), $options: 'i' } });
  if (jobId || stage) {
    const af: any = { company_id: cid };
    if (jobId) af.job_id = jobId; if (stage) af.stage = stage;
    and.push({ id: { $in: await db.applications.distinct('candidate_id', af) } });
  }
  const filter: any = { company_id: cid };
  if (and.length) filter.$and = and;
  const rows = await db.candidates.list(filter, { sort: { created_at: -1 }, limit: 300 });
  const counts = rows.length ? await db.applications.aggregate([
    { $match: { company_id: cid, candidate_id: { $in: rows.map(r => r.id) } } }, { $group: { _id: '$candidate_id', n: { $sum: 1 } } },
  ]) : [];
  const byCand = new Map<string, number>(counts.map((c: any) => [c._id, c.n]));
  res.json({ items: rows.map(r => candOut({ ...r, applications: byCand.get(r.id) ?? 0 })) });
}));

recruitRouter.post('/candidates', requirePerm('candidates.write'), wrap(async (req, res) => {
  const b = parse(candBody, req.body);
  if (await db.candidates.exists({ company_id: tenant(req), email: b.email })) throw new HttpError(409, 'A candidate with this email already exists', 'duplicate');
  let id = '';
  try {
    await tx(async () => {
      id = await db.candidates.insert({
        company_id: tenant(req), name: b.name, email: b.email, phone: b.phone ?? null, current_title: b.current_title ?? null, current_company: b.current_company ?? null,
        location: b.location ?? null, experience_years: b.experience_years ?? null, skills: JSON.stringify(b.skills.map(s => s.toLowerCase())), tags: JSON.stringify(b.tags),
        source: b.source ?? 'manual', created_by: req.auth!.userId, created_at: now(),
      });
      if (b.jobId) await createApplication(tenant(req), b.jobId, id, req.auth!.userId);
    });
  } catch (e) { if (isDuplicateKey(e)) throw new HttpError(409, 'A candidate with this email already exists', 'duplicate'); throw e; }
  await audit(tenant(req), req.auth!, 'candidate.created', id, req);
  res.status(201).json(candOut(await db.candidates.get({ id })));
}));

recruitRouter.post('/candidates/import', requirePerm('candidates.write'), wrap(async (req, res) => {
  const { rows, jobId } = parse(z.object({ rows: z.array(z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().optional(), current_title: z.string().optional(), skills: z.string().optional() })).min(1).max(500), jobId: z.string().nullish() }), req.body);
  let created = 0; const skipped: string[] = [];
  await tx(async () => {
    created = 0; skipped.length = 0;
    for (const r of rows) {
      const email = r.email.toLowerCase();
      if (await db.candidates.exists({ company_id: tenant(req), email })) { skipped.push(email); continue; }
      const id = await db.candidates.insert({
        company_id: tenant(req), name: r.name, email, phone: r.phone ?? null, current_title: r.current_title ?? null,
        skills: JSON.stringify((r.skills || '').split(/[,;|]/).map(s => s.trim().toLowerCase()).filter(Boolean)), source: 'import', created_by: req.auth!.userId, created_at: now(),
      });
      if (jobId) await createApplication(tenant(req), jobId, id, req.auth!.userId);
      created++;
    }
  });
  await audit(tenant(req), req.auth!, 'candidate.imported', String(created), req);
  res.json({ created, skipped });
}));

async function getCand(req: any) {
  const c = await db.candidates.get({ id: req.params.id, company_id: tenant(req) });
  if (!c) throw notFound('Candidate not found');
  return c as any;
}

recruitRouter.get('/candidates/:id', requirePerm('candidates.read'), wrap(async (req, res) => {
  const c = await getCand(req); const cid = tenant(req);
  const resumes = (await db.candidate_resumes.list({ candidate_id: c.id, company_id: cid }, { sort: { uploaded_at: -1 } })).map(r => pick(r, ['id', 'original_name', 'mime', 'size', 'uploaded_at']));
  const rawApps = await db.applications.list({ candidate_id: c.id, company_id: cid }, { sort: { created_at: -1 } });
  const jobs = rawApps.length ? await db.jobs.list({ company_id: cid, id: { $in: uniq(rawApps.map(a => a.job_id)) } }) : [];
  const jm = new Map(jobs.map(x => [x.id, x]));
  const applications = rawApps.filter(a => jm.has(a.job_id)).map(a => ({ ...a, job_title: jm.get(a.job_id).title, match_detail: j(a.match_detail, null) }));
  const appIds = rawApps.map(a => a.id);
  const ivs = appIds.length ? await db.interviews.list({ company_id: cid, application_id: { $in: appIds } }, { sort: { scheduled_at: -1 } }) : [];
  const interviews = ivs.map(i => pick(i, ['id', 'title', 'round_no', 'type', 'scheduled_at', 'status', 'application_id']));
  const ivIds = ivs.map(i => i.id);
  const coding = ivIds.length ? (await db.coding_submissions.list({ company_id: cid, interview_id: { $in: ivIds }, kind: 'submit' }, { sort: { created_at: -1 }, limit: 20 }))
    .map(s => pick(s, ['id', 'interview_id', 'language', 'kind', 'passed', 'total', 'score', 'created_at'])) : [];
  const canFb = can(req.auth!.role ?? undefined, 'feedback.viewAll');
  let feedback: any[] = [];
  if (canFb && ivIds.length) {
    const fbs = await db.interview_feedback.list({ company_id: cid, interview_id: { $in: ivIds }, submitted: 1 });
    const users = fbs.length ? await db.users.list({ id: { $in: uniq(fbs.map(f => f.interviewer_id)) } }) : [];
    const um = new Map(users.map(u => [u.id, u]));
    feedback = fbs.filter(f => um.has(f.interviewer_id)).map(f => ({ interview_id: f.interview_id, recommendation: f.recommendation ?? null, evidence: f.evidence ?? null, ratings: j(f.ratings, {}), interviewer: um.get(f.interviewer_id).name }));
  }
  const recordings = can(req.auth!.role ?? undefined, 'recordings.view') && ivIds.length
    ? (await db.interview_recordings.list({ company_id: cid, interview_id: { $in: ivIds }, status: 'ready' })).map(r => pick(r, ['id', 'interview_id', 'source', 'status', 'created_at'])) : [];
  const activity = (await db.activity.list({ candidate_id: c.id, company_id: cid }, { sort: { created_at: -1 }, limit: 50 })).map(a => pick(a, ['action', 'detail', 'created_at']));
  res.json({ candidate: candOut(c), resumes, applications, interviews, coding, feedback, recordings, activity });
}));

recruitRouter.patch('/candidates/:id', requirePerm('candidates.write'), wrap(async (req, res) => {
  const c = await getCand(req);
  const b = parse(candBody.partial().omit({ jobId: true, email: true }), req.body);
  const m: any = { ...candOut(c), ...b };
  await db.candidates.set({ id: c.id, company_id: tenant(req) }, {
    name: m.name, phone: m.phone ?? null, current_title: m.current_title ?? null, current_company: m.current_company ?? null, location: m.location ?? null,
    experience_years: m.experience_years ?? null, skills: JSON.stringify((m.skills as string[]).map(s => s.toLowerCase())), tags: JSON.stringify(m.tags), source: m.source ?? null,
  });
  res.json(candOut(await db.candidates.get({ id: c.id })));
}));

/** Data-subject deletion workflow: removes candidate, resumes, applications, interviews and recordings. */
recruitRouter.delete('/candidates/:id', requirePerm('candidates.write'), wrap(async (req, res) => {
  const c = await getCand(req); const cid = tenant(req);
  if (!['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Only owners/admins can permanently delete candidate data');
  const apps = await db.applications.list({ candidate_id: c.id, company_id: cid });
  const appIds = apps.map(a => a.id);
  const ivIds = appIds.length ? (await db.interviews.list({ company_id: cid, application_id: { $in: appIds } })).map(i => i.id) : [];
  const files = [
    ...(await db.candidate_resumes.list({ candidate_id: c.id, company_id: cid })),
    ...(ivIds.length ? await db.interview_recordings.list({ company_id: cid, interview_id: { $in: ivIds } }) : []),
  ];
  await tx(async () => {
    await db.activity.del({ candidate_id: c.id, company_id: cid });
    // No FK cascades in MongoDB: remove dependents explicitly.
    if (ivIds.length) {
      for (const coll of ['interview_participants', 'interview_invitations', 'camera_sessions', 'interview_recordings', 'recording_events', 'chat_messages', 'coding_assessments',
        'coding_submissions', 'code_snapshots', 'whiteboard_sessions', 'interview_feedback', 'interview_transcripts'] as const) await db[coll].del({ company_id: cid, interview_id: { $in: ivIds } });
      await db.interviews.del({ company_id: cid, id: { $in: ivIds } });
    }
    if (appIds.length) {
      await db.application_notes.del({ company_id: cid, application_id: { $in: appIds } });
      await db.applications.del({ company_id: cid, id: { $in: appIds } });
    }
    await db.candidate_resumes.del({ candidate_id: c.id, company_id: cid });
    await db.candidates.del({ id: c.id, company_id: cid });
  });
  files.forEach(f => deleteFile(f.file_key));
  await audit(cid, req.auth!, 'candidate.deleted', c.id, req, { reason: 'erasure' });
  res.json({ ok: true });
}));

recruitRouter.post('/candidates/:id/resume', requirePerm('candidates.write'), upload.single('file'), wrap(async (req, res) => {
  const c = await getCand(req);
  if (!req.file) throw bad('Attach a file');
  await scanFile(req.file.buffer);
  const { text, type } = await extractText(req.file.buffer);
  if (type === 'txt' && !/\.txt$/i.test(req.file.originalname)) throw new HttpError(415, 'Unsupported file type');
  const key = saveFile(tenant(req), req.file.buffer, '.' + type);
  const parsed = parseResume(text);
  await db.candidate_resumes.insert({
    company_id: tenant(req), candidate_id: c.id, file_key: key, original_name: path.basename(req.file.originalname).slice(0, 120), mime: type, size: req.file.size,
    parsed_text: text.slice(0, 60000), uploaded_at: now(),
  });
  const skills = [...new Set([...j<string[]>(c.skills, []), ...parsed.skills])];
  const upd: any = { skills: JSON.stringify(skills) };
  if (c.experience_years == null && parsed.experience_years != null) upd.experience_years = parsed.experience_years;
  if (c.phone == null && parsed.phone != null) upd.phone = parsed.phone;
  await db.candidates.set({ id: c.id, company_id: tenant(req) }, upd);
  // refresh match scores for this candidate's applications
  const apps = await db.applications.list({ candidate_id: c.id, company_id: tenant(req) });
  const jobs = apps.length ? await db.jobs.list({ company_id: tenant(req), id: { $in: uniq(apps.map(a => a.job_id)) } }) : [];
  const jm = new Map(jobs.map(x => [x.id, x]));
  for (const a of apps) {
    const jb = jm.get(a.job_id); if (!jb) continue;
    const mm = matchScore({ required_skills: j(jb.required_skills, []), preferred_skills: j(jb.preferred_skills, []), exp_min: jb.exp_min }, { skills, experience_years: parsed.experience_years ?? c.experience_years });
    await db.applications.set({ id: a.id, company_id: tenant(req) }, { match_score: mm.score, match_detail: JSON.stringify(mm.detail) });
  }
  await logActivity(tenant(req), { candidateId: c.id, actorId: req.auth!.userId, action: 'resume.uploaded', detail: req.file.originalname });
  res.status(201).json({ ok: true, extractedSkills: parsed.skills });
}));

/** Public "parse a resume to prefill the add-candidate form" helper (nothing is stored). */
recruitRouter.post('/candidates/parse-resume', requirePerm('candidates.write'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Attach a file');
  await scanFile(req.file.buffer);
  const { text } = await extractText(req.file.buffer);
  res.json({ parsed: parseResume(text) });
}));

recruitRouter.post('/candidates/:id/resumes/:rid/link', requirePerm('candidates.read'), wrap(async (req, res) => {
  const r = await db.candidate_resumes.get({ id: req.params.rid, candidate_id: req.params.id, company_id: tenant(req) });
  if (!r) throw notFound();
  await audit(tenant(req), req.auth!, 'resume.accessed', String(req.params.rid), req);
  res.json({ url: `/api/files/${signFileToken({ k: 'resume', id: String(req.params.rid), cid: tenant(req), uid: req.auth!.userId }, 120)}` });
}));

/* =============== APPLICATIONS =============== */
recruitRouter.post('/candidates/:id/applications', requirePerm('candidates.write'), wrap(async (req, res) => {
  const c = await getCand(req);
  const { jobId } = parse(z.object({ jobId: z.string() }), req.body);
  res.status(201).json({ id: await createApplication(tenant(req), jobId, c.id, req.auth!.userId) });
}));

async function getApp(req: any) {
  const a = await db.applications.get({ id: req.params.id, company_id: tenant(req) });
  if (!a) throw notFound('Application not found');
  return a as any;
}

recruitRouter.patch('/applications/:id/stage', requirePerm('candidates.write'), wrap(async (req, res) => {
  const a = await getApp(req);
  const { stage } = parse(z.object({ stage: z.string() }), req.body);
  if (!(await stagesOf(tenant(req))).includes(stage)) throw bad('Unknown stage');
  if (['Selected', 'Rejected'].includes(stage) && !can(req.auth!.role ?? undefined, 'decision.make'))
    throw new HttpError(403, 'Final hiring decisions must be made by a hiring manager or admin (human review required).', 'human_review_required');
  await db.applications.set({ id: a.id, company_id: tenant(req) }, { stage, updated_at: now() });
  await logActivity(tenant(req), { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'stage.changed', detail: `${a.stage} → ${stage}` });
  res.json({ ok: true });
}));

recruitRouter.post('/applications/:id/decision', requirePerm('decision.make'), wrap(async (req, res) => {
  const a = await getApp(req);
  const b = parse(z.object({ decision: z.enum(['selected', 'rejected', 'on_hold']), note: z.string().max(2000).default('') }), req.body);
  const stage = { selected: 'Selected', rejected: 'Rejected', on_hold: 'On Hold' }[b.decision];
  await db.applications.set({ id: a.id, company_id: tenant(req) }, { decision: b.decision, decision_by: req.auth!.userId, decision_note: b.note, stage, updated_at: now() });
  await logActivity(tenant(req), { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'decision.made', detail: `${b.decision}${b.note ? ': ' + b.note : ''}` });
  await audit(tenant(req), req.auth!, 'application.decision', a.id, req, b);
  res.json({ ok: true });
}));

recruitRouter.get('/applications/:id/notes', requirePerm('candidates.read'), wrap(async (req, res) => {
  const a = await getApp(req);
  const notes = await db.application_notes.list({ application_id: a.id, company_id: tenant(req) }, { sort: { created_at: -1 } });
  const users = notes.length ? await db.users.list({ id: { $in: uniq(notes.map(n => n.author_id)) } }) : [];
  const um = new Map(users.map(u => [u.id, u]));
  res.json({ items: notes.filter(n => um.has(n.author_id)).map(n => ({ id: n.id, body: n.body, created_at: n.created_at, author: um.get(n.author_id).name })) });
}));
recruitRouter.post('/applications/:id/notes', requirePerm('candidates.read'), wrap(async (req, res) => {
  const a = await getApp(req);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  await db.application_notes.insert({ company_id: tenant(req), application_id: a.id, author_id: req.auth!.userId, body, created_at: now() });
  await logActivity(tenant(req), { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'note.added' });
  res.status(201).json({ ok: true });
}));

recruitRouter.post('/applications/:id/rematch', requirePerm('candidates.write'), wrap(async (req, res) => {
  const a = await getApp(req);
  const jb = await db.jobs.get({ id: a.job_id, company_id: tenant(req) }), c = await db.candidates.get({ id: a.candidate_id, company_id: tenant(req) });
  if (!jb || !c) throw notFound('Application not found');
  const mm = matchScore({ required_skills: j(jb.required_skills, []), preferred_skills: j(jb.preferred_skills, []), exp_min: jb.exp_min }, { skills: j(c.skills, []), experience_years: c.experience_years });
  await db.applications.set({ id: a.id, company_id: tenant(req) }, { match_score: mm.score, match_detail: JSON.stringify(mm.detail) });
  res.json({ score: mm.score, detail: mm.detail });
}));

/* =============== signed file download =============== */
filesRouter.get('/:token', wrap(async (req, res) => {
  const t = verifyFileToken(String(req.params.token));
  let key: string | null = null, mime = 'application/octet-stream', name = 'file';
  if (t.k === 'resume') {
    const r = await db.candidate_resumes.get({ id: t.id, company_id: t.cid });
    if (r) { key = r.file_key; name = r.original_name; mime = ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', txt: 'text/plain' } as any)[r.mime] || mime; }
  } else if (t.k === 'recording') {
    const r = await db.interview_recordings.get({ id: t.id, company_id: t.cid });
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

recruitRouter.get('/applications/:id', requirePerm('candidates.read'), wrap(async (req, res) => {
  const cid = tenant(req);
  const a = await db.applications.get({ id: req.params.id, company_id: cid });
  const jb = a ? await db.jobs.get({ id: a.job_id, company_id: cid }) : null;
  const c = a ? await db.candidates.get({ id: a.candidate_id, company_id: cid }) : null;
  if (!a || !jb || !c) throw notFound('Application not found');
  res.json({ id: a.id, stage: a.stage, job_id: a.job_id, job_title: jb.title, interviewer_ids: j(jb.interviewer_ids, []), candidate_id: c.id, candidate_name: c.name, candidate_email: c.email });
}));
