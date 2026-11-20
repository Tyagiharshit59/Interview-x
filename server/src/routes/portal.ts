/**
 * Candidate portal: job seekers' own accounts, completely separate from company staff accounts.
 *
 * Security model
 * - Separate identity collection (candidate_accounts) and a separate cookie signed with a separate key, so a candidate
 *   session can never be used against staff APIs and vice versa.
 * - A candidate sees company-side data (applications, interviews, shared updates) ONLY for records whose email equals the
 *   account email, and ONLY after that email has been verified. Otherwise anyone could sign up with someone else's address.
 * - Interviewer scorecards and internal notes are never exposed. Candidates see a friendly status and only the updates a
 *   company explicitly chooses to share (candidate_updates).
 * - Joining an interview from the portal goes through the same checks as an invitation link (status, join window).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, tx, isDuplicateKey, now, j, NOCASE } from '../db.js';
import { config } from '../config.js';
import { wrap, parse, HttpError, bad, notFound, newToken, sha256, addMinutes, isExpired } from '../util.js';
import { sendMail, notify, logActivity, audit, saveFile, safeKey, scanFile, deleteFile } from '../services.js';
import { extractText, parseResume, matchScore } from '../parsing.js';
import { createRoomTicket } from '../realtime.js';
import { requirePerm, tenant } from '../auth.js';
import { CONSENT_NOTICE } from './public.js';

export const portalRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isProd ? 60 : 600, standardHeaders: true, legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const password = z.string().min(8, 'At least 8 characters').max(128).regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number');
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------------- session ---------------- */
export const CAND_COOKIE = 'ivx_cand';
const candSecret = () => config.jwtSecret + ':candidate';
function issueCandSession(res: Response, acc: { id: string; session_version: number }) {
  const token = jwt.sign({ sub: acc.id, sv: acc.session_version, typ: 'cand' }, candSecret(), { expiresIn: '7d' });
  res.cookie(CAND_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 864e5, path: '/' });
}
async function accountFrom(req: Request) {
  const t = req.cookies?.[CAND_COOKIE]; if (!t) return null;
  let p: any; try { p = jwt.verify(t, candSecret()); } catch { return null; }
  if (p.typ !== 'cand') return null;
  const a = await db.candidate_accounts.get({ id: p.sub });
  return a && a.session_version === p.sv && a.status !== 'disabled' ? a : null;
}
declare module 'express-serve-static-core' { interface Request { cand?: any } }
const requireCandidate = (req: Request, _res: Response, next: NextFunction) => {
  accountFrom(req).then(a => { if (!a) return next(new HttpError(401, 'Please sign in to your candidate account', 'unauthenticated')); req.cand = a; next(); }).catch(next);
};
const optionalCandidate = (req: Request, _res: Response, next: NextFunction) => { accountFrom(req).then(a => { req.cand = a; next(); }).catch(next); };
const requireVerified = (req: Request) => { if (!req.cand.email_verified) throw new HttpError(403, 'Please verify your email address first. We sent you a link when you signed up.', 'email_unverified'); };

const profileOut = (a: any) => ({
  id: a.id, email: a.email, name: a.name, phone: a.phone ?? null, headline: a.headline ?? null, location: a.location ?? null,
  experience_years: a.experience_years ?? null, skills: j<string[]>(a.skills, []), summary: a.summary ?? null, linkedin: a.linkedin ?? null, portfolio: a.portfolio ?? null,
  resume: a.resume_key ? { name: a.resume_name, uploaded_at: a.resume_uploaded_at } : null, emailVerified: !!a.email_verified, created_at: a.created_at,
  completeness: completeness(a),
});
function completeness(a: any) {
  const checks = [!!a.name, !!a.phone, !!a.headline, !!a.location, a.experience_years != null, j<string[]>(a.skills, []).length >= 3, !!a.summary, !!a.resume_key, !!a.email_verified];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

async function tokenFor(accountId: string, purpose: string, minutes: number) {
  const raw = newToken();
  await db.user_tokens.insert({ token_hash: sha256(raw), user_id: accountId, purpose, expires_at: addMinutes(minutes), used_at: null, payload: null });
  return raw;
}
async function consume(raw: string, purpose: string) {
  const t = await db.user_tokens.get({ token_hash: sha256(raw), purpose });
  if (!t || t.used_at || isExpired(t.expires_at)) throw bad('This link is invalid or has expired', 'bad_token');
  await db.user_tokens.set({ token_hash: t.token_hash }, { used_at: now() });
  return t;
}
async function sendVerify(acc: { id: string; email: string; name: string }) {
  const raw = await tokenFor(acc.id, 'cand_verify_email', 60 * 24 * 3);
  const link = `${config.appUrl}/portal/verify?token=${raw}`;
  void sendMail(null, acc.email, 'Verify your email for IntervueX Careers', `Hi ${acc.name},\n\nConfirm your email to apply for jobs and see interviews companies have invited you to:\n${link}\n\nThis link is valid for 3 days.`);
  return link;
}

/* ---------------- auth ---------------- */
portalRouter.use(limiter);

portalRouter.post('/auth/register', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email(), password }), req.body);
  let id: string;
  try {
    id = await db.candidate_accounts.insert({ email: b.email, password_hash: bcrypt.hashSync(b.password, 12), name: b.name, skills: '[]', email_verified: 0, session_version: 0, status: 'active', failed_logins: 0, locked_until: null, created_at: now() });
  } catch (e) { if (isDuplicateKey(e)) throw new HttpError(409, 'An account with this email already exists. Try signing in.', 'email_taken'); throw e; }
  const acc = await db.candidate_accounts.get({ id });
  const link = await sendVerify(acc);
  issueCandSession(res, acc);
  res.status(201).json({ ...profileOut(acc), ...(config.isProd ? {} : { devVerifyUrl: link }) });
}));

portalRouter.post('/auth/login', wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
  const a = await db.candidate_accounts.get({ email: b.email });
  const fail = () => new HttpError(401, 'Incorrect email or password', 'bad_credentials');
  if (!a) { bcrypt.compareSync(b.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi'); throw fail(); }
  if (a.locked_until && !isExpired(a.locked_until)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.', 'locked');
  if (!bcrypt.compareSync(b.password, a.password_hash)) {
    const n = (a.failed_logins || 0) + 1;
    await db.candidate_accounts.set({ id: a.id }, { failed_logins: n >= 5 ? 0 : n, locked_until: n >= 5 ? addMinutes(15) : null });
    throw fail();
  }
  if (a.status === 'disabled') throw fail();
  await db.candidate_accounts.set({ id: a.id }, { failed_logins: 0, locked_until: null, last_login_at: now() });
  issueCandSession(res, a);
  res.json(profileOut(a));
}));
portalRouter.post('/auth/logout', (_req, res) => { res.clearCookie(CAND_COOKIE, { path: '/' }); res.json({ ok: true }); });
portalRouter.get('/me', requireCandidate, wrap(async (req, res) => { res.json(profileOut(req.cand)); }));

portalRouter.post('/auth/verify', wrap(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const t = await consume(token, 'cand_verify_email');
  await db.candidate_accounts.set({ id: t.user_id }, { email_verified: 1, verified_at: now() });
  res.json({ ok: true });
}));
portalRouter.post('/auth/resend-verification', requireCandidate, wrap(async (req, res) => {
  if (req.cand.email_verified) return res.json({ ok: true, already: true });
  const link = await sendVerify(req.cand);
  res.json({ ok: true, ...(config.isProd ? {} : { devVerifyUrl: link }) });
}));
portalRouter.post('/auth/forgot-password', wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const a = await db.candidate_accounts.get({ email });
  let devResetUrl: string | undefined;
  if (a) {
    const raw = await tokenFor(a.id, 'cand_reset_password', 60);
    devResetUrl = `${config.appUrl}/portal/reset-password?token=${raw}`;
    void sendMail(null, email, 'Reset your IntervueX Careers password', `Reset your password (valid for 1 hour): ${devResetUrl}\nIf you didn't request this, ignore this email.`);
  }
  res.json({ ok: true, ...(config.isProd ? {} : { devResetUrl }) });
}));
portalRouter.post('/auth/reset-password', wrap(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password }), req.body);
  const t = await consume(b.token, 'cand_reset_password');
  // A reset link sent to the inbox also proves ownership of the address.
  await db.candidate_accounts.update({ id: t.user_id }, { $set: { password_hash: bcrypt.hashSync(b.password, 12), failed_logins: 0, locked_until: null, email_verified: 1 }, $inc: { session_version: 1 } });
  res.json({ ok: true });
}));

/* ---------------- profile ---------------- */
portalRouter.patch('/profile', requireCandidate, wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100), phone: z.string().trim().max(30).nullable(), headline: z.string().trim().max(120).nullable(),
    location: z.string().trim().max(100).nullable(), experience_years: z.number().min(0).max(60).nullable(),
    skills: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(60), summary: z.string().trim().max(3000).nullable(),
    linkedin: z.string().trim().max(200).nullable(), portfolio: z.string().trim().max(200).nullable(),
  }).partial(), req.body);
  const upd: any = { ...b, updated_at: now() };
  if (b.skills) upd.skills = JSON.stringify([...new Set(b.skills)]);
  for (const k of ['phone', 'headline', 'location', 'summary', 'linkedin', 'portfolio'] as const) if (upd[k] === '') upd[k] = null;
  await db.candidate_accounts.set({ id: req.cand.id }, upd);
  res.json(profileOut(await db.candidate_accounts.get({ id: req.cand.id })));
}));

portalRouter.post('/profile/resume', requireCandidate, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('Attach a PDF, DOCX or TXT file');
  await scanFile(req.file.buffer);
  const { text, type } = await extractText(req.file.buffer);
  if (!['pdf', 'docx', 'doc', 'txt'].includes(type) || (type === 'txt' && !/\.txt$/i.test(req.file.originalname))) throw new HttpError(415, 'Please upload a PDF, DOCX or TXT file');
  const parsed = parseResume(text);
  const key = saveFile('portal', req.file.buffer, '.' + type);
  const old = req.cand.resume_key;
  const skills = [...new Set([...j<string[]>(req.cand.skills, []), ...parsed.skills])];
  await db.candidate_accounts.set({ id: req.cand.id }, {
    resume_key: key, resume_name: path.basename(req.file.originalname).slice(0, 120), resume_type: type, resume_text: text.slice(0, 60000), resume_uploaded_at: now(),
    skills: JSON.stringify(skills), ...(req.cand.experience_years == null && parsed.experience_years != null ? { experience_years: parsed.experience_years } : {}),
    ...(!req.cand.phone && parsed.phone ? { phone: parsed.phone } : {}),
  });
  if (old) deleteFile(old);
  res.status(201).json({ ...profileOut(await db.candidate_accounts.get({ id: req.cand.id })), extractedSkills: parsed.skills });
}));
portalRouter.get('/profile/resume', requireCandidate, wrap(async (req, res) => {
  if (!req.cand.resume_key) throw notFound('No CV uploaded yet');
  const mime = ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', txt: 'text/plain' } as any)[req.cand.resume_type] || 'application/octet-stream';
  res.setHeader('Content-Type', mime); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${String(req.cand.resume_name || 'cv').replace(/[^\w.\- ]/g, '_')}"`);
  fs.createReadStream(safeKey(req.cand.resume_key)).pipe(res);
}));

/* ---------------- job board ---------------- */
/** Published, non-template jobs of active companies that have not opted the job out of the public board. */
async function boardFilter(extra: any = {}) {
  const activeCos = (await db.companies.list({ status: 'active' }, { projection: { _id: 1 } })).map(c => c.id);
  return { status: 'published', is_template: { $ne: 1 }, public_listing: { $ne: 0 }, company_id: { $in: activeCos }, ...extra };
}
const jobCard = (jb: any, co: any, match?: number | null) => ({
  id: jb.id, title: jb.title, company: co?.name ?? 'Company', company_industry: co?.industry ?? null, department: jb.department ?? null, location: jb.location ?? null,
  employment_type: jb.employment_type ?? null, exp_min: jb.exp_min ?? null, exp_max: jb.exp_max ?? null, required_skills: j<string[]>(jb.required_skills, []),
  posted_at: jb.updated_at || jb.created_at, match: match ?? null,
});
/** Score shown to the candidate only when at least one skill overlaps; otherwise experience alone would produce a misleading number. */
const shownScore = (m: ReturnType<typeof matchScore> | null) => m && (m.detail.matchedRequired.length + m.detail.matchedPreferred.length) > 0 ? m.score : null;
const accountMatch = (jb: any, acc: any) => acc ? matchScore({ required_skills: j(jb.required_skills, []), preferred_skills: j(jb.preferred_skills, []), exp_min: jb.exp_min }, { skills: j(acc.skills, []), experience_years: acc.experience_years }) : null;
async function companiesById(ids: string[]) { return new Map((ids.length ? await db.companies.list({ id: { $in: [...new Set(ids)] } }) : []).map((c: any) => [c.id, c])); }
/** Application ids per job for this account (only verified accounts can have portal-visible applications). */
async function myApplications(acc: any) {
  if (!acc?.email_verified) return [] as any[];
  const cands = await db.candidates.list({ email: acc.email }, { collation: NOCASE });
  if (!cands.length) return [];
  return db.applications.list({ candidate_id: { $in: cands.map(c => c.id) } }, { sort: { created_at: -1 } });
}

portalRouter.get('/jobs', optionalCandidate, wrap(async (req, res) => {
  const { q, location, type, skill, sort } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(req.query.page) || 1); const size = 12;
  const and: any[] = [];
  if (q) { const rx = { $regex: escapeRegex(q.slice(0, 80)), $options: 'i' }; and.push({ $or: [{ title: rx }, { department: rx }, { description: rx }, { required_skills: rx }] }); }
  if (location) and.push({ location: { $regex: escapeRegex(location.slice(0, 60)), $options: 'i' } });
  if (type) and.push({ employment_type: { $regex: `^${escapeRegex(type.slice(0, 40))}$`, $options: 'i' } });
  if (skill) and.push({ required_skills: { $regex: escapeRegex(skill.slice(0, 40)), $options: 'i' } });
  const filter = await boardFilter(and.length ? { $and: and } : {});
  const all = await db.jobs.list(filter, { sort: { updated_at: -1 }, limit: 500 });
  const cos = await companiesById(all.map(x => x.company_id));
  let items = all.map(jb => jobCard(jb, cos.get(jb.company_id), shownScore(accountMatch(jb, req.cand))));
  if (sort === 'match' && req.cand) items = items.sort((a, b) => (b.match ?? 0) - (a.match ?? 0));
  const applied = new Set((await myApplications(req.cand)).map(a => a.job_id));
  const saved = req.cand ? new Set((await db.saved_jobs.list({ account_id: req.cand.id })).map(s => s.job_id)) : new Set();
  const total = items.length;
  items = items.slice((page - 1) * size, page * size).map(x => ({ ...x, applied: applied.has(x.id), saved: saved.has(x.id) }));
  const locations = [...new Set(all.map(x => x.location).filter(Boolean))].slice(0, 30);
  const types = [...new Set(all.map(x => x.employment_type).filter(Boolean))];
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / size)), facets: { locations, types } });
}));

portalRouter.get('/jobs/:id', optionalCandidate, wrap(async (req, res) => {
  const jb = await db.jobs.get(await boardFilter({ id: String(req.params.id) }));
  if (!jb) throw notFound('This job is no longer open');
  const co = await db.companies.get({ id: jb.company_id });
  const m = accountMatch(jb, req.cand);
  const app = (await myApplications(req.cand)).find(a => a.job_id === jb.id);
  const saved = req.cand ? await db.saved_jobs.exists({ account_id: req.cand.id, job_id: jb.id }) : false;
  res.json({
    ...jobCard(jb, co, shownScore(m)), description: jb.description ?? null, responsibilities: jb.responsibilities ?? null, qualifications: jb.qualifications ?? null,
    preferred_skills: j<string[]>(jb.preferred_skills, []), screening_questions: j<any[]>(jb.screening_questions, []).map(q => (typeof q === 'string' ? q : q?.question)).filter(Boolean),
    company_website: co?.website ?? null, matchDetail: m?.detail ?? null, applied: !!app, applicationId: app?.id ?? null, saved,
  });
}));

portalRouter.get('/recommendations', requireCandidate, wrap(async (req, res) => {
  const skills = j<string[]>(req.cand.skills, []);
  if (!skills.length) return res.json({ items: [], reason: 'Add skills or upload your CV to get recommendations.' });
  const all = await db.jobs.list(await boardFilter(), { sort: { updated_at: -1 }, limit: 500 });
  const applied = new Set((await myApplications(req.cand)).map(a => a.job_id));
  const cos = await companiesById(all.map(x => x.company_id));
  const scored = all.filter(jb => !applied.has(jb.id)).map(jb => {
    const m = accountMatch(jb, req.cand)!;
    return { jb, score: m.score, hits: m.detail.matchedRequired.length + m.detail.matchedPreferred.length, matched: [...m.detail.matchedRequired, ...m.detail.matchedPreferred] };
  }).filter(x => x.hits > 0).sort((a, b) => b.score - a.score || b.hits - a.hits).slice(0, 12);
  res.json({ items: scored.map(x => ({ ...jobCard(x.jb, cos.get(x.jb.company_id), x.score), matchedSkills: x.matched })), reason: 'Based on the skills and experience in your profile. This is a keyword match, not a judgement of your ability.' });
}));

/* ---------------- saved jobs ---------------- */
portalRouter.get('/saved', requireCandidate, wrap(async (req, res) => {
  const s = await db.saved_jobs.list({ account_id: req.cand.id }, { sort: { created_at: -1 } });
  const jobs = s.length ? await db.jobs.list(await boardFilter({ id: { $in: s.map(x => x.job_id) } })) : [];
  const cos = await companiesById(jobs.map(x => x.company_id)); const byId = new Map(jobs.map(x => [x.id, x]));
  res.json({ items: s.filter(x => byId.has(x.job_id)).map(x => ({ ...jobCard(byId.get(x.job_id), cos.get(byId.get(x.job_id).company_id), shownScore(accountMatch(byId.get(x.job_id), req.cand))), saved: true, saved_at: x.created_at })) });
}));
portalRouter.post('/jobs/:id/save', requireCandidate, wrap(async (req, res) => {
  if (!(await db.jobs.exists(await boardFilter({ id: String(req.params.id) })))) throw notFound('This job is no longer open');
  await db.saved_jobs.upsert({ account_id: req.cand.id, job_id: String(req.params.id) }, {}, { created_at: now() });
  res.json({ ok: true, saved: true });
}));
portalRouter.delete('/jobs/:id/save', requireCandidate, wrap(async (req, res) => {
  await db.saved_jobs.del({ account_id: req.cand.id, job_id: String(req.params.id) });
  res.json({ ok: true, saved: false });
}));

/* ---------------- apply ---------------- */
portalRouter.post('/jobs/:id/apply', requireCandidate, wrap(async (req, res) => {
  requireVerified(req);
  const acc = req.cand;
  const b = parse(z.object({ cover_note: z.string().trim().max(4000).optional().nullable(), answers: z.array(z.object({ question: z.string().max(500), answer: z.string().trim().max(2000) })).max(20).default([]) }), req.body);
  const jb = await db.jobs.get(await boardFilter({ id: String(req.params.id) }));
  if (!jb) throw notFound('This job is no longer open');
  const cid = jb.company_id;
  const skills = j<string[]>(acc.skills, []);
  if (!acc.resume_key && skills.length === 0) throw bad('Add your skills or upload a CV before applying, so the company can review your profile.', 'profile_incomplete');
  const required = j<any[]>(jb.screening_questions, []).map(q => (typeof q === 'string' ? q : q?.question)).filter(Boolean);
  if (required.length && b.answers.filter(a => a.answer).length < required.length) throw bad('Please answer all screening questions.', 'answers_required');
  let appId = '';
  // Copy the CV into the hiring company's storage so its retention/deletion rules apply to its copy.
  let copiedKey: string | null = null;
  if (acc.resume_key) { try { copiedKey = saveFile(cid, fs.readFileSync(safeKey(acc.resume_key)), '.' + (acc.resume_type || 'pdf')); } catch { copiedKey = null; } }
  try {
    await tx(async () => {
      let cand = await db.candidates.get({ company_id: cid, email: acc.email }, { collation: NOCASE });
      const profile = { name: acc.name, phone: acc.phone ?? null, current_title: acc.headline ?? null, location: acc.location ?? null, experience_years: acc.experience_years ?? null };
      if (!cand) {
        const id = await db.candidates.insert({ company_id: cid, email: acc.email, ...profile, current_company: null, skills: JSON.stringify(skills), tags: JSON.stringify(['portal']), source: 'portal', account_id: acc.id, created_by: null, created_at: now() });
        cand = await db.candidates.get({ id });
      } else {
        const merged = [...new Set([...j<string[]>(cand.skills, []), ...skills])];
        await db.candidates.set({ id: cand.id, company_id: cid }, { skills: JSON.stringify(merged), account_id: acc.id, ...(cand.phone ? {} : { phone: profile.phone }), ...(cand.location ? {} : { location: profile.location }), ...(cand.experience_years != null ? {} : { experience_years: profile.experience_years }) });
        cand = await db.candidates.get({ id: cand.id });
      }
      if (await db.applications.exists({ company_id: cid, job_id: jb.id, candidate_id: cand.id })) throw new HttpError(409, 'You have already applied for this job', 'already_applied');
      if (copiedKey) await db.candidate_resumes.insert({ company_id: cid, candidate_id: cand.id, file_key: copiedKey, original_name: acc.resume_name || 'cv', mime: acc.resume_type || 'pdf', size: fs.statSync(safeKey(copiedKey)).size, parsed_text: (acc.resume_text || '').slice(0, 60000), uploaded_at: now() });
      const stages = j<any>((await db.companies.get({ id: cid }))?.settings, {}).hiringStages || ['Applied'];
      const mm = matchScore({ required_skills: j(jb.required_skills, []), preferred_skills: j(jb.preferred_skills, []), exp_min: jb.exp_min }, { skills: j(cand.skills, []), experience_years: cand.experience_years });
      const t = now();
      appId = await db.applications.insert({ company_id: cid, job_id: jb.id, candidate_id: cand.id, stage: stages[0], match_score: mm.score, match_detail: JSON.stringify(mm.detail), source: 'portal',
        cover_note: b.cover_note || null, screening_answers: JSON.stringify(b.answers.filter(a => a.answer)), created_at: t, updated_at: t });
      await logActivity(cid, { applicationId: appId, candidateId: cand.id, action: 'application.created', detail: `Applied via careers portal to ${jb.title}` });
    });
  } catch (e) { if (copiedKey) deleteFile(copiedKey); if (isDuplicateKey(e)) throw new HttpError(409, 'You have already applied for this job', 'already_applied'); throw e; }
  // tell the people who own hiring at that company
  const roles = ['owner', 'admin', 'hr', 'recruiter'];
  const recipients = jb.recruiter_id ? [{ user_id: jb.recruiter_id }] : await db.company_members.list({ company_id: cid, role: { $in: roles }, status: 'active' });
  for (const r of recipients) await notify(cid, r.user_id, 'application', `New application: ${jb.title}`, `${acc.name} applied through the careers portal.`, `/jobs/${jb.id}`);
  void sendMail(null, acc.email, `Application received: ${jb.title}`, `Hi ${acc.name},\n\nYour application for ${jb.title} has been received. Track its progress in your IntervueX Careers dashboard: ${config.appUrl}/portal/applications`);
  res.status(201).json({ ok: true, applicationId: appId });
}));

/* ---------------- my applications ---------------- */
/** Internal pipeline stages are mapped to plain, candidate-friendly statuses. Internal notes and scores are never shown. */
function friendly(stage: string) {
  const s = (stage || '').toLowerCase();
  if (s === 'withdrawn') return { key: 'withdrawn', label: 'Withdrawn', step: 0 };
  if (s === 'applied') return { key: 'received', label: 'Application received', step: 1 };
  if (s.includes('interview scheduled')) return { key: 'interview', label: 'Interview scheduled', step: 3 };
  if (s.includes('interview completed') || s.includes('evaluation')) return { key: 'interviewed', label: 'Interview completed', step: 3 };
  if (s.includes('selected') || s.includes('offer') || s.includes('hired')) return { key: 'selected', label: 'Selected', step: 4 };
  if (s.includes('reject')) return { key: 'closed', label: 'Not progressing', step: 4 };
  return { key: 'review', label: 'Under review', step: 2 };
}

portalRouter.get('/applications', requireCandidate, wrap(async (req, res) => {
  if (!req.cand.email_verified) return res.json({ items: [], needsVerification: true });
  const apps = await myApplications(req.cand);
  const jobs = new Map((apps.length ? await db.jobs.list({ id: { $in: apps.map(a => a.job_id) } }) : []).map(x => [x.id, x]));
  const cos = await companiesById(apps.map(a => a.company_id));
  const updates = apps.length ? await db.candidate_updates.list({ application_id: { $in: apps.map(a => a.id) } }, { sort: { created_at: -1 } }) : [];
  const ivs = apps.length ? await db.interviews.list({ application_id: { $in: apps.map(a => a.id) } }) : [];
  res.json({
    items: apps.map(a => {
      const jb = jobs.get(a.job_id); const st = friendly(a.stage);
      return {
        id: a.id, job_id: a.job_id, job_title: jb?.title ?? 'Role', company: cos.get(a.company_id)?.name ?? 'Company', location: jb?.location ?? null,
        status: st, applied_at: a.created_at, updated_at: a.updated_at, source: a.source ?? 'company',
        interviews: ivs.filter(i => i.application_id === a.id && i.status !== 'cancelled').map(i => ({ id: i.id, title: i.title, scheduled_at: i.scheduled_at, status: i.status })),
        updates: updates.filter(u => u.application_id === a.id).map(u => ({ id: u.id, kind: u.kind, message: u.message, from: u.author_name, created_at: u.created_at })),
        canWithdraw: !['withdrawn', 'selected', 'closed'].includes(st.key),
      };
    }),
  });
}));

portalRouter.post('/applications/:id/withdraw', requireCandidate, wrap(async (req, res) => {
  requireVerified(req);
  const a = (await myApplications(req.cand)).find(x => x.id === String(req.params.id));
  if (!a) throw notFound('Application not found');
  if (['withdrawn', 'selected', 'closed'].includes(friendly(a.stage).key)) throw bad('This application can no longer be withdrawn');
  await db.applications.set({ id: a.id, company_id: a.company_id }, { stage: 'Withdrawn', updated_at: now() });
  await logActivity(a.company_id, { applicationId: a.id, candidateId: a.candidate_id, action: 'application.withdrawn', detail: 'Withdrawn by the candidate in the careers portal' });
  res.json({ ok: true });
}));

/* ---------------- my interviews (only those a company invited this person to) ---------------- */
async function myInterviews(acc: any) {
  const apps = await myApplications(acc);
  if (!apps.length) return [];
  const ivs = await db.interviews.list({ application_id: { $in: apps.map(a => a.id) }, status: { $ne: 'cancelled' } }, { sort: { scheduled_at: 1 } });
  const appBy = new Map(apps.map(a => [a.id, a]));
  const jobs = new Map((await db.jobs.list({ id: { $in: apps.map(a => a.job_id) } })).map(x => [x.id, x]));
  const cos = await companiesById(ivs.map(i => i.company_id));
  return ivs.map(i => {
    const a = appBy.get(i.application_id); const cfg = j<any>(i.config, {});
    const start = new Date(i.scheduled_at).getTime();
    return {
      id: i.id, company_id: i.company_id, title: i.title, company: cos.get(i.company_id)?.name ?? 'Company', job_title: jobs.get(a.job_id)?.title ?? '', scheduled_at: i.scheduled_at,
      duration_min: i.duration_min, timezone: i.timezone, status: i.status, instructions: i.instructions ?? null, round_no: i.round_no,
      features: { coding: !!cfg.coding, whiteboard: cfg.whiteboard !== false, recording: !!cfg.recording, secondaryCamera: !!cfg.secondaryCamera },
      opensAt: new Date(start - 30 * 60_000).toISOString(), canJoin: i.status !== 'completed' && Date.now() >= start - 30 * 60_000,
    };
  });
}
portalRouter.get('/interviews', requireCandidate, wrap(async (req, res) => {
  if (!req.cand.email_verified) return res.json({ upcoming: [], past: [], needsVerification: true });
  const all = await myInterviews(req.cand);
  res.json({ upcoming: all.filter(i => i.status !== 'completed'), past: all.filter(i => i.status === 'completed').reverse() });
}));
portalRouter.get('/interviews/:id', requireCandidate, wrap(async (req, res) => {
  requireVerified(req);
  const i = (await myInterviews(req.cand)).find(x => x.id === String(req.params.id));
  if (!i) throw notFound('Interview not found');
  res.json({ ...i, notice: CONSENT_NOTICE, candidateFirstName: String(req.cand.name).split(' ')[0], serverTime: now() });
}));
portalRouter.post('/interviews/:id/ticket', requireCandidate, wrap(async (req, res) => {
  requireVerified(req);
  const i = (await myInterviews(req.cand)).find(x => x.id === String(req.params.id));
  if (!i) throw notFound('Interview not found');
  if (i.status === 'completed') throw new HttpError(410, 'This interview has already finished.', 'completed');
  if (!i.canJoin) throw new HttpError(425, 'The interview room opens 30 minutes before the start time.', 'too_early', { opensAt: i.opensAt });
  await audit(i.company_id, { email: req.cand.email }, 'join.portal', i.id, req);
  const ticket = createRoomTicket({ interviewId: i.id, companyId: i.company_id, kind: 'candidate', name: req.cand.name, role: 'candidate' });
  res.json({ ticket, iceServers: config.iceServers });
}));

/* ---------------- dashboard summary ---------------- */
portalRouter.get('/overview', requireCandidate, wrap(async (req, res) => {
  const apps = await myApplications(req.cand);
  const ivs = req.cand.email_verified ? await myInterviews(req.cand) : [];
  const keys = apps.map(a => friendly(a.stage).key);
  res.json({
    profile: profileOut(req.cand),
    counts: { applications: apps.length, active: keys.filter(k => !['withdrawn', 'closed', 'selected'].includes(k)).length, interviews: ivs.filter(i => i.status !== 'completed').length, saved: await db.saved_jobs.count({ account_id: req.cand.id }) },
    nextInterview: ivs.find(i => i.status !== 'completed') ?? null,
    updates: apps.length ? (await db.candidate_updates.list({ application_id: { $in: apps.map(a => a.id) } }, { sort: { created_at: -1 }, limit: 5 })).map(u => ({ id: u.id, message: u.message, from: u.author_name, company_id: u.company_id, created_at: u.created_at, kind: u.kind })) : [],
  });
}));

/* ======================= staff side: share an update with the candidate ======================= */
export const candidateUpdatesRouter = Router();
candidateUpdatesRouter.get('/applications/:id/updates', requirePerm('candidates.read'), wrap(async (req, res) => {
  const a = await db.applications.get({ id: req.params.id, company_id: tenant(req) });
  if (!a) throw notFound('Application not found');
  const cand = await db.candidates.get({ id: a.candidate_id, company_id: tenant(req) });
  const acc = cand ? await db.candidate_accounts.get({ email: String(cand.email).toLowerCase() }) : null;
  res.json({ items: await db.candidate_updates.list({ application_id: a.id, company_id: tenant(req) }, { sort: { created_at: -1 } }), candidateHasPortal: !!acc?.email_verified });
}));
candidateUpdatesRouter.post('/applications/:id/updates', requirePerm('candidates.write'), wrap(async (req, res) => {
  const b = parse(z.object({ message: z.string().trim().min(5).max(3000), kind: z.enum(['update', 'feedback']).default('update') }), req.body);
  const cid = tenant(req);
  const a = await db.applications.get({ id: req.params.id, company_id: cid });
  if (!a) throw notFound('Application not found');
  const cand = await db.candidates.get({ id: a.candidate_id, company_id: cid });
  const jb = await db.jobs.get({ id: a.job_id, company_id: cid });
  const co = await db.companies.get({ id: cid });
  const id = await db.candidate_updates.insert({ company_id: cid, application_id: a.id, candidate_id: a.candidate_id, kind: b.kind, message: b.message, author_id: req.auth!.userId, author_name: `${req.auth!.name} · ${co.name}`, created_at: now() });
  await logActivity(cid, { applicationId: a.id, candidateId: a.candidate_id, actorId: req.auth!.userId, action: 'candidate.update_shared', detail: b.message.slice(0, 120) });
  await audit(cid, req.auth!, 'candidate.update_shared', a.id, req);
  if (cand?.email) void sendMail(cid, cand.email, `${b.kind === 'feedback' ? 'Feedback' : 'An update'} on your application: ${jb?.title ?? ''}`, `Hi ${cand.name},\n\n${co.name} shared ${b.kind === 'feedback' ? 'feedback' : 'an update'} about your application for ${jb?.title ?? 'a role'}:\n\n${b.message}\n\nSee all your applications: ${config.appUrl}/portal/applications`);
  res.status(201).json({ ok: true, id });
}));
