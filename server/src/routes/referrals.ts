/**
 * Employee referral programme.
 *
 * - Employees are company members with the `employee` role. They have no self sign-up: HR or an admin creates the account
 *   (Team → Add team member) and the employee activates it with a single-use link.
 * - An employee session can only use the referral endpoints (see the default-deny guard in index.ts), so employees never see
 *   candidates, interview questions, feedback or company settings.
 * - Employees see a candidate-friendly status of their own referrals only, never interview notes or scores.
 * - Bonus lifecycle: pending → eligible (when the referred candidate is Selected, after the waiting period) → paid (HR marks it),
 *   or not_eligible (candidate rejected/withdrawn) / declined (HR decision with a reason).
 */
import { Router } from 'express';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { db, tx, isDuplicateKey, now, j, NOCASE } from '../db.js';
import { requirePerm, tenant } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound, addDays } from '../util.js';
import { audit, notify, logActivity, saveFile, scanFile, deleteFile, sendMail } from '../services.js';
import { extractText, parseResume, matchScore } from '../parsing.js';

export const referralRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

export const DEFAULT_PROGRAM = { enabled: true, defaultBonus: 10000, currency: 'INR', payoutAfterDays: 90, terms: 'The bonus is paid when the person you referred is hired and has completed the waiting period. Referrals of candidates already in our pipeline for the same role are not eligible.' };
async function program(cid: string) {
  const c = await db.companies.get({ id: cid });
  return { ...DEFAULT_PROGRAM, ...(j<any>(c?.settings, {}).referralProgram || {}) };
}
const bonusFor = (jb: any, prog: any) => (jb.referral_bonus != null ? Number(jb.referral_bonus) : Number(prog.defaultBonus) || 0);

/** Candidate-friendly status; the employee never sees internal stage names, notes or scores. */
function friendly(stage: string) {
  const s = (stage || '').toLowerCase();
  if (s === 'withdrawn') return { key: 'withdrawn', label: 'Withdrawn', step: 0 };
  if (s === 'applied') return { key: 'received', label: 'Referral received', step: 1 };
  if (s.includes('interview')) return { key: 'interviewing', label: 'Interviewing', step: 3 };
  if (s.includes('evaluation')) return { key: 'interviewing', label: 'Interviewing', step: 3 };
  if (s.includes('selected') || s.includes('offer') || s.includes('hired')) return { key: 'hired', label: 'Hired', step: 4 };
  if (s.includes('reject')) return { key: 'closed', label: 'Not progressing', step: 4 };
  return { key: 'review', label: 'In review', step: 2 };
}
/** Derives the bonus state from the application outcome (stored state wins once HR has acted). */
function bonusState(r: any, app: any, prog: any) {
  if (['paid', 'declined'].includes(r.bonus_status)) return { status: r.bonus_status, eligibleOn: r.eligible_on ?? null };
  const f = friendly(app?.stage);
  if (f.key === 'hired') {
    const hiredAt = r.hired_at || app?.updated_at || now();
    const eligibleOn = addDays(Number(prog.payoutAfterDays) || 0, new Date(hiredAt));
    return { status: new Date(eligibleOn) <= new Date() ? 'eligible' : 'pending_waiting', eligibleOn };
  }
  if (f.key === 'closed' || f.key === 'withdrawn' || !app) return { status: 'not_eligible', eligibleOn: null };
  return { status: 'pending', eligibleOn: null };
}
const BONUS_LABEL: Record<string, string> = { pending: 'Pending outcome', pending_waiting: 'Waiting period', eligible: 'Ready for payout', paid: 'Paid', not_eligible: 'Not eligible', declined: 'Declined' };

async function hydrate(cid: string, rows: any[]) {
  const apps = new Map((rows.length ? await db.applications.list({ company_id: cid, id: { $in: rows.map(r => r.application_id) } }) : []).map(a => [a.id, a]));
  const jobs = new Map((rows.length ? await db.jobs.list({ company_id: cid, id: { $in: [...new Set(rows.map(r => r.job_id))] } }) : []).map(x => [x.id, x]));
  const prog = await program(cid);
  // remember when a referral first became "hired" so the waiting period has a stable start date
  for (const r of rows) {
    const a = apps.get(r.application_id);
    if (a && friendly(a.stage).key === 'hired' && !r.hired_at) { r.hired_at = a.updated_at || now(); await db.referrals.set({ id: r.id, company_id: cid }, { hired_at: r.hired_at }); }
  }
  return rows.map(r => {
    const a = apps.get(r.application_id); const b = bonusState(r, a, prog);
    return { r, a, job: jobs.get(r.job_id), status: friendly(a?.stage), bonus: { amount: r.bonus_amount, currency: prog.currency, status: b.status, label: BONUS_LABEL[b.status], eligibleOn: b.eligibleOn, paid_at: r.paid_at ?? null, note: r.bonus_note ?? null } };
  });
}

/* ---------------- programme ---------------- */
referralRouter.get('/referrals/program', requirePerm('referrals.create'), wrap(async (req, res) => res.json(await program(tenant(req)))));
referralRouter.put('/referrals/program', requirePerm('referrals.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean(), defaultBonus: z.number().int().min(0).max(10_000_000), payoutAfterDays: z.number().int().min(0).max(730), terms: z.string().trim().max(3000) }), req.body);
  const c = await db.companies.get({ id: tenant(req) });
  const settings = { ...j<any>(c.settings, {}), referralProgram: { ...b, currency: 'INR' } };
  await db.companies.set({ id: tenant(req) }, { settings: JSON.stringify(settings) });
  await audit(tenant(req), req.auth!, 'referrals.program_updated', tenant(req), req, b);
  res.json(await program(tenant(req)));
}));

/* ---------------- open roles employees can refer for ---------------- */
referralRouter.get('/referrals/jobs', requirePerm('referrals.create'), wrap(async (req, res) => {
  const cid = tenant(req); const prog = await program(cid);
  const jobs = await db.jobs.list({ company_id: cid, status: 'published', is_template: { $ne: 1 }, referrals_enabled: { $ne: 0 } }, { sort: { updated_at: -1 } });
  res.json({
    program: prog,
    items: prog.enabled ? jobs.map(x => ({ id: x.id, title: x.title, department: x.department ?? null, location: x.location ?? null, employment_type: x.employment_type ?? null, exp_min: x.exp_min ?? null, exp_max: x.exp_max ?? null,
      required_skills: j<string[]>(x.required_skills, []), description: x.description ?? null, responsibilities: x.responsibilities ?? null, bonus: bonusFor(x, prog), posted_at: x.updated_at })) : [],
  });
}));

/* ---------------- submit a referral ---------------- */
referralRouter.post('/referrals', requirePerm('referrals.create'), upload.single('cv'), wrap(async (req, res) => {
  const cid = tenant(req);
  const b = parse(z.object({
    job_id: z.string().min(1), name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email(), phone: z.string().trim().max(30).optional().nullable(),
    relationship: z.enum(['former_colleague', 'friend', 'classmate', 'family', 'professional_network', 'other']),
    linkedin: z.string().trim().max(200).optional().nullable(), note: z.string().trim().max(3000).optional().nullable(),
    consent: z.union([z.literal(true), z.literal('true')]),
  }), req.body);
  const prog = await program(cid);
  if (!prog.enabled) throw new HttpError(403, 'The referral programme is currently paused.', 'program_disabled');
  const jb = await db.jobs.get({ id: b.job_id, company_id: cid, status: 'published', is_template: { $ne: 1 }, referrals_enabled: { $ne: 0 } });
  if (!jb) throw notFound('This role is not open for referrals');
  const me = await db.users.get({ id: req.auth!.userId });
  if (me && me.email.toLowerCase() === b.email) throw bad('You cannot refer yourself. Ask HR about applying internally.', 'self_referral');

  let cv: { key: string; type: string; text: string; name: string; size: number } | null = null;
  if (req.file) {
    await scanFile(req.file.buffer);
    const { text, type } = await extractText(req.file.buffer);
    if (!['pdf', 'docx', 'doc', 'txt'].includes(type) || (type === 'txt' && !/\.txt$/i.test(req.file.originalname))) throw new HttpError(415, 'The CV must be a PDF, DOCX or TXT file');
    cv = { key: saveFile(cid, req.file.buffer, '.' + type), type, text, name: path.basename(req.file.originalname).slice(0, 120), size: req.file.size };
  }
  const parsed = cv ? parseResume(cv.text) : { skills: [] as string[], experience_years: undefined as number | undefined };
  let referralId = '';
  try {
    await tx(async () => {
      let cand = await db.candidates.get({ company_id: cid, email: b.email }, { collation: NOCASE });
      if (cand && await db.applications.exists({ company_id: cid, job_id: jb.id, candidate_id: cand.id }))
        throw new HttpError(409, 'This person is already being considered for this role, so the referral cannot be added.', 'already_in_pipeline');
      if (!cand) {
        const id = await db.candidates.insert({ company_id: cid, name: b.name, email: b.email, phone: b.phone || null, current_title: null, current_company: null, location: null,
          experience_years: parsed.experience_years ?? null, skills: JSON.stringify(parsed.skills), tags: JSON.stringify(['referral']), source: 'referral', created_by: req.auth!.userId, created_at: now() });
        cand = await db.candidates.get({ id });
      }
      if (cv) await db.candidate_resumes.insert({ company_id: cid, candidate_id: cand.id, file_key: cv.key, original_name: cv.name, mime: cv.type, size: cv.size, parsed_text: cv.text.slice(0, 60000), uploaded_at: now() });
      const stages = j<any>((await db.companies.get({ id: cid }))?.settings, {}).hiringStages || ['Applied'];
      const mm = matchScore({ required_skills: j(jb.required_skills, []), preferred_skills: j(jb.preferred_skills, []), exp_min: jb.exp_min }, { skills: j(cand.skills, []), experience_years: cand.experience_years });
      const t = now();
      const appId = await db.applications.insert({ company_id: cid, job_id: jb.id, candidate_id: cand.id, stage: stages[0], match_score: mm.score, match_detail: JSON.stringify(mm.detail), source: 'referral', referred_by: req.auth!.userId, created_at: t, updated_at: t });
      referralId = await db.referrals.insert({
        company_id: cid, referrer_id: req.auth!.userId, referrer_name: req.auth!.name, job_id: jb.id, job_title: jb.title, candidate_id: cand.id, application_id: appId,
        candidate_name: b.name, candidate_email: b.email, relationship: b.relationship, linkedin: b.linkedin || null, note: b.note || null,
        bonus_amount: bonusFor(jb, prog), bonus_status: 'pending', hired_at: null, paid_at: null, paid_by: null, bonus_note: null, created_at: t, updated_at: t,
      });
      await logActivity(cid, { applicationId: appId, candidateId: cand.id, actorId: req.auth!.userId, action: 'referral.created', detail: `Referred by ${req.auth!.name} for ${jb.title}` });
    });
  } catch (e) { if (cv) deleteFile(cv.key); if (isDuplicateKey(e)) throw new HttpError(409, 'This person is already being considered for this role.', 'already_in_pipeline'); throw e; }
  await audit(cid, req.auth!, 'referral.created', referralId, req, { job: jb.id });
  const hr = jb.recruiter_id ? [{ user_id: jb.recruiter_id }] : await db.company_members.list({ company_id: cid, role: { $in: ['owner', 'admin', 'hr', 'recruiter'] }, status: 'active' });
  for (const m of hr) if (m.user_id !== req.auth!.userId) await notify(cid, m.user_id, 'referral', `New referral: ${jb.title}`, `${req.auth!.name} referred ${b.name}.`, `/referrals/manage`);
  res.status(201).json({ ok: true, id: referralId });
}));

/* ---------------- my referrals ---------------- */
referralRouter.get('/referrals/mine', requirePerm('referrals.create'), wrap(async (req, res) => {
  const cid = tenant(req);
  const rows = await db.referrals.list({ company_id: cid, referrer_id: req.auth!.userId }, { sort: { created_at: -1 } });
  const h = await hydrate(cid, rows);
  const sum = (st: string[]) => h.filter(x => st.includes(x.bonus.status)).reduce((s, x) => s + (x.r.bonus_amount || 0), 0);
  res.json({
    items: h.map(x => ({ id: x.r.id, candidate_name: x.r.candidate_name, job_title: x.job?.title ?? x.r.job_title, relationship: x.r.relationship, created_at: x.r.created_at, status: x.status, bonus: x.bonus })),
    summary: { total: h.length, inProgress: h.filter(x => ['received', 'review', 'interviewing'].includes(x.status.key)).length, hired: h.filter(x => x.status.key === 'hired').length,
      paid: sum(['paid']), upcoming: sum(['pending_waiting', 'eligible']), currency: (await program(cid)).currency },
  });
}));

/* ---------------- HR: all referrals ---------------- */
referralRouter.get('/referrals', requirePerm('referrals.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const rows = await db.referrals.list({ company_id: cid }, { sort: { created_at: -1 }, limit: 1000 });
  const h = await hydrate(cid, rows);
  const leaders = new Map<string, { name: string; total: number; hired: number }>();
  for (const x of h) { const l = leaders.get(x.r.referrer_id) || { name: x.r.referrer_name, total: 0, hired: 0 }; l.total++; if (x.status.key === 'hired') l.hired++; leaders.set(x.r.referrer_id, l); }
  res.json({
    items: h.map(x => ({ id: x.r.id, referrer_name: x.r.referrer_name, referrer_id: x.r.referrer_id, candidate_id: x.r.candidate_id, candidate_name: x.r.candidate_name, candidate_email: x.r.candidate_email,
      job_id: x.r.job_id, job_title: x.job?.title ?? x.r.job_title, stage: x.a?.stage ?? null, relationship: x.r.relationship, note: x.r.note, linkedin: x.r.linkedin, created_at: x.r.created_at, status: x.status, bonus: x.bonus })),
    leaderboard: [...leaders.values()].sort((a, b) => b.hired - a.hired || b.total - a.total).slice(0, 10),
    totals: { referrals: h.length, hired: h.filter(x => x.status.key === 'hired').length, toPay: h.filter(x => x.bonus.status === 'eligible').reduce((s, x) => s + (x.r.bonus_amount || 0), 0), paid: h.filter(x => x.bonus.status === 'paid').reduce((s, x) => s + (x.r.bonus_amount || 0), 0) },
  });
}));

referralRouter.patch('/referrals/:id/bonus', requirePerm('referrals.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const b = parse(z.object({ action: z.enum(['mark_paid', 'decline', 'reopen']), note: z.string().trim().max(500).optional().nullable(), amount: z.number().int().min(0).max(10_000_000).optional() }), req.body);
  const r = await db.referrals.get({ id: req.params.id, company_id: cid });
  if (!r) throw notFound('Referral not found');
  const [x] = await hydrate(cid, [r]);
  if (b.action === 'mark_paid') {
    if (x.bonus.status !== 'eligible') throw bad(x.bonus.status === 'paid' ? 'This bonus is already paid.' : 'Only bonuses that are ready for payout can be marked paid.', 'not_eligible');
    await db.referrals.set({ id: r.id, company_id: cid }, { bonus_status: 'paid', paid_at: now(), paid_by: req.auth!.userId, bonus_note: b.note || null, ...(b.amount != null ? { bonus_amount: b.amount } : {}), updated_at: now() });
    await notify(cid, r.referrer_id, 'referral', 'Referral bonus paid 🎉', `Your bonus for referring ${r.candidate_name} (${r.job_title}) has been marked as paid.`, '/referrals/mine', { email: true });
  } else if (b.action === 'decline') {
    if (!b.note) throw bad('Please give a reason when declining a bonus; the employee will see it.');
    if (x.bonus.status === 'paid') throw bad('A paid bonus cannot be declined.');
    await db.referrals.set({ id: r.id, company_id: cid }, { bonus_status: 'declined', bonus_note: b.note, updated_at: now() });
    await notify(cid, r.referrer_id, 'referral', 'Update on your referral bonus', `Your bonus for referring ${r.candidate_name} was declined: ${b.note}`, '/referrals/mine');
  } else {
    if (x.bonus.status === 'paid') throw bad('A paid bonus cannot be reopened.');
    await db.referrals.set({ id: r.id, company_id: cid }, { bonus_status: 'pending', bonus_note: null, updated_at: now() });
  }
  await audit(cid, req.auth!, `referral.bonus_${b.action}`, r.id, req, { amount: b.amount ?? r.bonus_amount, note: b.note });
  res.json({ ok: true });
}));

/* ---------------- HR: employees overview (accounts are created from Team → Add team member) ---------------- */
referralRouter.get('/referrals/employees', requirePerm('employees.manage'), wrap(async (req, res) => {
  const cid = tenant(req);
  const ms = await db.company_members.list({ company_id: cid, role: 'employee' });
  const users = ms.length ? await db.users.list({ id: { $in: ms.map(m => m.user_id) } }) : [];
  const byId = new Map(users.map(u => [u.id, u]));
  const counts = ms.length ? await db.referrals.aggregate([{ $match: { company_id: cid, referrer_id: { $in: ms.map(m => m.user_id) } } }, { $group: { _id: '$referrer_id', n: { $sum: 1 } } }]) : [];
  const nBy = new Map(counts.map((c: any) => [c._id, c.n]));
  res.json({ items: ms.filter(m => byId.has(m.user_id)).map(m => { const u = byId.get(m.user_id); return { id: m.id, user_id: m.user_id, name: u.name, email: u.email, designation: m.designation ?? null, status: m.status, pending_activation: !u.password_hash, referrals: nBy.get(m.user_id) ?? 0, created_at: m.created_at }; })
    .sort((a, b) => a.name.localeCompare(b.name)) });
}));

void sendMail;
