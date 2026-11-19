import { Router } from 'express';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
import { config } from '../config.js';
import { requirePerm, tenant, can } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound } from '../util.js';
import { audit, enforce, recordUsage, notify } from '../services.js';
import { isParticipant } from './interviews.js';
import { DEFAULT_CRITERIA } from './coding.js';

export const evalRouter = Router();

function iv(req: any) {
  const i = db.prepare('SELECT * FROM interviews WHERE id=? AND company_id=?').get(req.params.id, tenant(req));
  if (!i) throw notFound('Interview not found');
  return i as any;
}

/* =============== FEEDBACK =============== */
const REC = ['strong_hire', 'hire', 'hold', 'no_hire'] as const;

evalRouter.get('/interviews/:id/feedback', requirePerm('interviews.read'), wrap((req, res) => {
  const i = iv(req); const cid = tenant(req); const role = req.auth!.role ?? undefined;
  const tpl = db.prepare('SELECT criteria FROM evaluation_templates WHERE company_id=? ORDER BY created_at DESC LIMIT 1').get(cid) as any;
  const criteria = tpl ? j(tpl.criteria, DEFAULT_CRITERIA) : DEFAULT_CRITERIA;
  const mine = db.prepare('SELECT * FROM interview_feedback WHERE interview_id=? AND interviewer_id=? AND company_id=?').get(i.id, req.auth!.userId, cid) as any;
  // Independence: other interviewers' feedback is visible only after you submit yours (or to HR/hiring managers/admins).
  const seeOthers = can(role, 'feedback.viewAll') || !!mine?.submitted;
  const others = seeOthers ? db.prepare(`SELECT f.id, f.ratings, f.evidence, f.recommendation, u.name interviewer FROM interview_feedback f JOIN users u ON u.id=f.interviewer_id
    WHERE f.interview_id=? AND f.company_id=? AND f.submitted=1 AND f.interviewer_id!=?`).all(i.id, cid, req.auth!.userId) as any[] : [];
  const pendingFrom = (db.prepare(`SELECT u.name FROM interview_participants p JOIN users u ON u.id=p.user_id WHERE p.interview_id=? AND NOT EXISTS (SELECT 1 FROM interview_feedback f WHERE f.interview_id=p.interview_id AND f.interviewer_id=p.user_id AND f.submitted=1)`).all(i.id) as any[]).map(r => r.name);
  res.json({
    criteria, canSubmit: isParticipant(i.id, req.auth!.userId) && can(role, 'feedback.submit'), interview: { id: i.id, title: i.title, status: i.status },
    mine: mine ? { ratings: j(mine.ratings, {}), evidence: mine.evidence, private_notes: mine.private_notes, recommendation: mine.recommendation, submitted: !!mine.submitted } : null,
    others: others.map(o => ({ ...o, ratings: j(o.ratings, {}) })), pendingFrom,
    note: 'Ratings reflect observed evidence in this interview only. Traits like confidence or fluency are not objective measures of ability.',
  });
}));

evalRouter.put('/interviews/:id/feedback', requirePerm('feedback.submit'), wrap((req, res) => {
  const i = iv(req); const cid = tenant(req);
  if (!isParticipant(i.id, req.auth!.userId)) throw new HttpError(403, 'Only interviewers assigned to this interview can submit feedback');
  const b = parse(z.object({
    ratings: z.record(z.string().max(60), z.number().int().min(1).max(5)).default({}), evidence: z.string().max(8000).default(''), private_notes: z.string().max(8000).default(''),
    recommendation: z.enum(REC).nullable().default(null), submit: z.boolean().default(false),
  }), req.body);
  const cur = db.prepare('SELECT submitted FROM interview_feedback WHERE interview_id=? AND interviewer_id=?').get(i.id, req.auth!.userId) as any;
  if (cur?.submitted) throw new HttpError(409, 'Feedback already submitted', 'submitted');
  if (b.submit) {
    if (!b.recommendation) throw bad('Choose a recommendation (Strong Hire, Hire, Hold or No Hire)');
    if (b.evidence.trim().length < 20) throw bad('Please add evidence-based notes (what you observed) before submitting');
    if (!Object.keys(b.ratings).length) throw bad('Rate at least one criterion');
  }
  db.prepare(`INSERT INTO interview_feedback(id,company_id,interview_id,interviewer_id,ratings,evidence,private_notes,recommendation,submitted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(interview_id,interviewer_id) DO UPDATE SET ratings=excluded.ratings, evidence=excluded.evidence, private_notes=excluded.private_notes, recommendation=excluded.recommendation, submitted=excluded.submitted, updated_at=excluded.updated_at`)
    .run(uid(), cid, i.id, req.auth!.userId, JSON.stringify(b.ratings), b.evidence, b.private_notes, b.recommendation, +b.submit, now(), now());
  if (b.submit) {
    audit(cid, req.auth!, 'feedback.submitted', i.id, req);
    const remaining = (db.prepare(`SELECT COUNT(*) c FROM interview_participants p WHERE p.interview_id=? AND NOT EXISTS (SELECT 1 FROM interview_feedback f WHERE f.interview_id=p.interview_id AND f.interviewer_id=p.user_id AND f.submitted=1)`).get(i.id) as any).c;
    if (remaining === 0) {
      for (const m of db.prepare("SELECT user_id FROM company_members WHERE company_id=? AND role IN ('hiring_manager','owner','admin') AND status='active'").all(cid) as any[])
        notify(cid, m.user_id, 'decision', `All feedback is in: ${i.title}`, 'Review the consolidated feedback and make a decision.', `/interviews/${i.id}/feedback`);
    }
  }
  res.json({ ok: true });
}));

evalRouter.get('/interviews/:id/consolidated', requirePerm('feedback.viewAll'), wrap((req, res) => {
  const i = iv(req);
  const rows = db.prepare('SELECT ratings, recommendation FROM interview_feedback WHERE interview_id=? AND company_id=? AND submitted=1').all(i.id, tenant(req)) as any[];
  const sums: Record<string, { total: number; n: number }> = {}; const recs: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(j<Record<string, number>>(r.ratings, {}))) { (sums[k] ||= { total: 0, n: 0 }).total += v; sums[k].n++; }
    if (r.recommendation) recs[r.recommendation] = (recs[r.recommendation] || 0) + 1;
  }
  res.json({ submitted: rows.length, averages: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round((v.total / v.n) * 10) / 10])), recommendations: recs,
    note: 'Averages summarise interviewer ratings. They are an aid, not a decision. A human hiring manager makes the final call.' });
}));

/* =============== TRANSCRIPTS =============== */
evalRouter.post('/interviews/:id/transcript', requirePerm('interviews.conduct'), wrap((req, res) => {
  const i = iv(req);
  const b = parse(z.object({ segments: z.array(z.object({ speaker: z.string().max(60).default('Speaker'), text: z.string().trim().min(1).max(4000), offset_sec: z.number().min(0).default(0) })).min(1).max(500) }), req.body);
  for (const s of b.segments) db.prepare('INSERT INTO interview_transcripts(id,company_id,interview_id,speaker,text,offset_sec,source,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid(), tenant(req), i.id, s.speaker, s.text, s.offset_sec, 'manual', now());
  res.status(201).json({ ok: true, count: b.segments.length });
}));
evalRouter.get('/interviews/:id/transcript', requirePerm('recordings.view'), wrap((req, res) => {
  const i = iv(req);
  res.json({ items: db.prepare('SELECT speaker,text,offset_sec,source FROM interview_transcripts WHERE interview_id=? AND company_id=? ORDER BY offset_sec, created_at').all(i.id, tenant(req)) });
}));

/* =============== AI ASSISTANCE =============== */
const DISCLAIMER = 'AI-generated draft. It may be incomplete or wrong, was produced without seeing the candidate, and must be reviewed and edited by a human. It does not assess personality, emotion or any protected characteristic and must not be used as the sole basis for a hiring decision.';

function aiGate(req: any) {
  const cid = tenant(req);
  const co = db.prepare('SELECT settings FROM companies WHERE id=?').get(cid) as any;
  const s = j(co.settings, {} as any);
  if (s.aiEnabled === false) throw new HttpError(403, 'AI features are turned off for your company (Settings → AI & data).', 'ai_disabled');
  enforce(cid, { feature: 'ai', metric: 'ai_calls', limitKey: 'ai_calls_per_month' });
  return s;
}

async function callProvider(system: string, user: string): Promise<string | null> {
  if (!config.ai.baseUrl || !config.ai.apiKey || !config.ai.model) return null;
  try {
    const r = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` }, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model: config.ai.model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    return d.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}
const SYSTEM = 'You assist hiring teams. Be factual and concise. Never infer personality, emotion, age, gender, ethnicity, accent or other protected traits. Never recommend hiring or rejecting. Base statements only on supplied text.';

function save(cid: string, kind: string, content: any, provider: string, userId: string, interviewId?: string, jobId?: string) {
  const id = uid();
  db.prepare('INSERT INTO ai_reports(id,company_id,interview_id,job_id,kind,content,provider,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, cid, interviewId ?? null, jobId ?? null, kind, JSON.stringify(content), provider, userId, now());
  recordUsage(cid, 'ai_calls', 1, id);
  return id;
}
const out = (id: string, kind: string, provider: string, content: any) => ({ id, kind, aiGenerated: true, provider, disclaimer: DISCLAIMER, content });

evalRouter.post('/ai/questions', requirePerm('ai.use'), wrap(async (req, res) => {
  const s = aiGate(req);
  const b = parse(z.object({ jobId: z.string(), count: z.number().int().min(3).max(15).default(8), focus: z.string().max(200).optional() }), req.body);
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND company_id=?').get(b.jobId, tenant(req)) as any;
  if (!job) throw notFound('Job not found');
  const req_ = j<string[]>(job.required_skills, []), pref = j<string[]>(job.preferred_skills, []);
  let questions: Array<{ question: string; why: string }> | null = null; let provider = 'rule-based';
  const text = await callProvider(SYSTEM + ' Reply as JSON: {"questions":[{"question":"","why":""}]}', `Role: ${job.title}\nSkills: ${req_.join(', ')}\nPreferred: ${pref.join(', ')}\nResponsibilities: ${(job.responsibilities || '').slice(0, 1500)}\nFocus: ${b.focus || 'general'}\nWrite ${b.count} interview questions.`);
  if (text) { try { questions = JSON.parse(text.match(/\{[\s\S]*\}/)![0]).questions; provider = config.ai.model; } catch { questions = null; } }
  if (!questions) {
    const tpl = (sk: string) => [
      { question: `Walk me through a project where you used ${sk}. What were the hardest trade-offs?`, why: `Explores hands-on depth in ${sk}` },
      { question: `How would you debug a production issue involving ${sk}? What would you check first?`, why: `Probes practical troubleshooting in ${sk}` },
    ];
    questions = [...req_.slice(0, 4).flatMap(tpl), ...pref.slice(0, 1).flatMap(tpl).slice(0, 1),
      { question: 'Tell me about a time you disagreed with a teammate on a technical decision. How was it resolved?', why: 'Collaboration (use a structured rubric, not impressions)' },
      { question: `Design a small system relevant to the ${job.title} role. Which components, data model and failure modes would you consider?`, why: 'System design reasoning' }].slice(0, b.count);
  }
  const content = { questions, basedOn: { job: job.title, skills: req_ } };
  res.json(out(save(tenant(req), 'questions', content, provider, req.auth!.userId, undefined, job.id), 'questions', provider, content));
  void s;
}));

function interviewContext(i: any, cid: string, minimise: boolean) {
  const cand = db.prepare('SELECT c.name, a.job_id FROM applications a JOIN candidates c ON c.id=a.candidate_id WHERE a.id=?').get(i.application_id) as any;
  const job = db.prepare('SELECT title, required_skills FROM jobs WHERE id=?').get(cand.job_id) as any;
  const transcript = db.prepare('SELECT speaker,text FROM interview_transcripts WHERE interview_id=? AND company_id=? ORDER BY offset_sec, created_at').all(i.id, cid) as any[];
  const chat = db.prepare('SELECT sender_name,body FROM chat_messages WHERE interview_id=? AND company_id=? ORDER BY created_at').all(i.id, cid) as any[];
  const subs = db.prepare("SELECT passed,total,score,language FROM coding_submissions WHERE interview_id=? AND company_id=? AND kind='submit' ORDER BY created_at").all(i.id, cid) as any[];
  const events = db.prepare('SELECT kind,label,offset_sec FROM recording_events WHERE interview_id=? AND company_id=? AND kind NOT LIKE ? ORDER BY offset_sec').all(i.id, cid, 'signal:%') as any[];
  const mask = (s: string) => (minimise ? s.split(cand.name).join('the candidate') : s);
  return { cand, job, skills: j<string[]>(job.required_skills, []), transcript: transcript.map(t => ({ speaker: mask(t.speaker), text: mask(t.text) })), chat, subs, events };
}

const topicsIn = (text: string, skills: string[]) => skills.filter(s => new RegExp(`\\b${s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));

evalRouter.post('/interviews/:id/ai/summary', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = iv(req); const s = aiGate(req);
  const ctx = interviewContext(i, tenant(req), s.aiDataMinimization !== false);
  if (!ctx.transcript.length) throw bad('There is no transcript yet. Add transcript text on the interview page first.', 'no_transcript');
  const text = ctx.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n').slice(0, 24000);
  let content: any = null; let provider = 'rule-based';
  const r = await callProvider(SYSTEM + ' Reply as JSON: {"summary":"","topicsCovered":[],"strengths":[],"areasToExplore":[]}', `Role: ${ctx.job.title}\nTranscript:\n${text}`);
  if (r) { try { content = JSON.parse(r.match(/\{[\s\S]*\}/)![0]); provider = config.ai.model; } catch { content = null; } }
  if (!content) {
    const topics = topicsIn(text, ctx.skills.length ? ctx.skills : []);
    const sentences = text.split(/(?<=[.!?])\s+/).filter(x => x.length > 40);
    content = {
      summary: `Transcript of ${ctx.transcript.length} segments. Key excerpts: ` + sentences.slice(0, 3).join(' '),
      topicsCovered: topics, strengths: [], areasToExplore: ctx.skills.filter(sk => !topics.includes(sk)).map(sk => `${sk} was not discussed in the transcript`),
      note: 'Generated by a simple keyword-based fallback because no AI provider is configured. Connect one in the server settings for richer summaries.',
    };
  }
  res.json(out(save(tenant(req), 'summary', content, provider, req.auth!.userId, i.id), 'summary', provider, content));
}));

evalRouter.post('/interviews/:id/ai/followups', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = iv(req); const s = aiGate(req);
  const b = parse(z.object({ context: z.string().trim().min(5).max(3000) }), req.body);
  let provider = 'rule-based'; let list: string[] | null = null;
  const r = await callProvider(SYSTEM + ' Reply as JSON: {"followups":["..."]}', `Candidate's answer or topic:\n${b.context}\nSuggest 4 follow-up probing questions.`);
  if (r) { try { list = JSON.parse(r.match(/\{[\s\S]*\}/)![0]).followups; provider = config.ai.model; } catch { list = null; } }
  if (!list) list = ['Can you give a concrete example from your own work?', 'What trade-offs did you consider and why did you choose this approach?', 'How would this change at 100× the scale?', 'What would you do differently if you did it again?'];
  void s;
  const content = { followups: list };
  res.json(out(save(tenant(req), 'followups', content, provider, req.auth!.userId, i.id), 'followups', provider, content));
}));

evalRouter.post('/interviews/:id/ai/feedback-draft', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = iv(req); const s = aiGate(req);
  const ctx = interviewContext(i, tenant(req), s.aiDataMinimization !== false);
  const text = ctx.transcript.map(t => `${t.speaker}: ${t.text}`).join('\n').slice(0, 20000);
  let provider = 'rule-based'; let content: any = null;
  const r = text ? await callProvider(SYSTEM + ' Reply as JSON: {"evidence":"observations only, no hire recommendation","strengthsObserved":[],"areasToProbe":[]}', `Role: ${ctx.job.title}\nTranscript:\n${text}`) : null;
  if (r) { try { content = JSON.parse(r.match(/\{[\s\S]*\}/)![0]); provider = config.ai.model; } catch { content = null; } }
  if (!content) {
    const sub = ctx.subs.at(-1);
    content = {
      evidence: [`Interview "${i.title}" covered: ${topicsIn(text, ctx.skills).join(', ') || 'topics not detected'}.`, sub ? `Coding: last submission passed ${sub.passed}/${sub.total} tests (${sub.language}).` : 'No coding submission recorded.', 'Add your own observations and examples before submitting.'].join('\n'),
      strengthsObserved: [], areasToProbe: [], note: 'Template draft (no AI provider configured). Recommendation is intentionally left for you.',
    };
  }
  res.json(out(save(tenant(req), 'feedback_draft', content, provider, req.auth!.userId, i.id), 'feedback_draft', provider, content));
}));

evalRouter.post('/interviews/:id/ai/coding-summary', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = iv(req); aiGate(req);
  const subs = db.prepare("SELECT language,passed,total,score,created_at FROM coding_submissions WHERE interview_id=? AND company_id=? AND kind='submit' ORDER BY created_at").all(i.id, tenant(req)) as any[];
  const runs = (db.prepare("SELECT COUNT(*) c FROM coding_submissions WHERE interview_id=? AND company_id=? AND kind='run'").get(i.id, tenant(req)) as any).c;
  if (!subs.length && !runs) throw bad('No coding activity recorded for this interview');
  const best = subs.reduce((m, s) => (s.score > (m?.score ?? -1) ? s : m), null as any);
  const content = {
    summary: `${runs} test runs and ${subs.length} submissions. ` + (best ? `Best submission: ${best.passed}/${best.total} tests passed (${best.score}%) in ${best.language}.` : 'No graded submission.'),
    submissions: subs, note: 'Computed from recorded test results. Review the code history in the playback view for approach and quality.',
  };
  res.json(out(save(tenant(req), 'coding_summary', content, 'computed', req.auth!.userId, i.id), 'coding_summary', 'computed', content));
}));

evalRouter.get('/interviews/:id/ai-reports', requirePerm('ai.use'), wrap((req, res) => {
  const i = iv(req);
  const rows = db.prepare('SELECT id,kind,content,provider,created_at FROM ai_reports WHERE interview_id=? AND company_id=? ORDER BY created_at DESC').all(i.id, tenant(req)) as any[];
  res.json({ disclaimer: DISCLAIMER, items: rows.map(r => ({ ...r, content: j(r.content, {}), aiGenerated: true })) });
}));
