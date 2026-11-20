import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { db, uid, now, j, tx } from '../db.js';
import { config } from '../config.js';
import { requirePerm, tenant, can } from '../auth.js';
import { wrap, parse, HttpError, bad, notFound } from '../util.js';
import { audit, enforce, recordUsage, notify, safeKey } from '../services.js';
import { isParticipant } from './interviews.js';
import { DEFAULT_CRITERIA } from './coding.js';

export const evalRouter = Router();

async function iv(req: any) {
  const i = await db.interviews.get({ id: String(req.params.id), company_id: tenant(req) });
  if (!i) throw notFound('Interview not found');
  return i as any;
}

/* =============== FEEDBACK =============== */
const REC = ['strong_hire', 'hire', 'hold', 'no_hire'] as const;

evalRouter.get('/interviews/:id/feedback', requirePerm('interviews.read'), wrap(async (req, res) => {
  const i = await iv(req); const cid = tenant(req); const role = req.auth!.role ?? undefined;
  const tpl = await db.evaluation_templates.get({ company_id: cid }, { sort: { created_at: -1 } });
  const criteria = tpl ? j(tpl.criteria, DEFAULT_CRITERIA) : DEFAULT_CRITERIA;
  const mine = await db.interview_feedback.get({ interview_id: i.id, interviewer_id: req.auth!.userId, company_id: cid });
  // Independence: other interviewers' feedback is visible only after you submit yours (or to HR/hiring managers/admins).
  const seeOthers = can(role, 'feedback.viewAll') || !!mine?.submitted;
  let others: any[] = [];
  if (seeOthers) {
    const fbs = await db.interview_feedback.list({ interview_id: i.id, company_id: cid, submitted: 1, interviewer_id: { $ne: req.auth!.userId } }, { sort: { _seq: 1 } });
    const us = await db.users.list({ id: { $in: fbs.map(f => f.interviewer_id) } }, { projection: { name: 1 } });
    const nameBy = new Map(us.map(u => [u.id, u.name]));
    others = fbs.filter(f => nameBy.has(f.interviewer_id)).map(f => ({ id: f.id, ratings: f.ratings, evidence: f.evidence, recommendation: f.recommendation, interviewer: nameBy.get(f.interviewer_id) }));
  }
  const parts = await db.interview_participants.list({ interview_id: i.id }, { sort: { _seq: 1 } });
  const submittedBy = new Set((await db.interview_feedback.list({ interview_id: i.id, submitted: 1 }, { projection: { interviewer_id: 1 } })).map(f => f.interviewer_id));
  const pendUsers = await db.users.list({ id: { $in: parts.filter(p => !submittedBy.has(p.user_id)).map(p => p.user_id) } }, { projection: { name: 1 } });
  const pendBy = new Map(pendUsers.map(u => [u.id, u.name]));
  const pendingFrom = parts.filter(p => pendBy.has(p.user_id)).map(p => pendBy.get(p.user_id));
  res.json({
    criteria, canSubmit: (await isParticipant(i.id, req.auth!.userId)) && can(role, 'feedback.submit'), interview: { id: i.id, title: i.title, status: i.status },
    mine: mine ? { ratings: j(mine.ratings, {}), evidence: mine.evidence, private_notes: mine.private_notes, recommendation: mine.recommendation, submitted: !!mine.submitted } : null,
    others: others.map(o => ({ ...o, ratings: j(o.ratings, {}) })), pendingFrom,
    note: 'Ratings reflect observed evidence in this interview only. Traits like confidence or fluency are not objective measures of ability.',
  });
}));

evalRouter.put('/interviews/:id/feedback', requirePerm('feedback.submit'), wrap(async (req, res) => {
  const i = await iv(req); const cid = tenant(req);
  if (!(await isParticipant(i.id, req.auth!.userId))) throw new HttpError(403, 'Only interviewers assigned to this interview can submit feedback');
  const b = parse(z.object({
    ratings: z.record(z.string().max(60), z.number().int().min(1).max(5)).default({}), evidence: z.string().max(8000).default(''), private_notes: z.string().max(8000).default(''),
    recommendation: z.enum(REC).nullable().default(null), submit: z.boolean().default(false),
  }), req.body);
  const cur = await db.interview_feedback.get({ interview_id: i.id, interviewer_id: req.auth!.userId });
  if (cur?.submitted) throw new HttpError(409, 'Feedback already submitted', 'submitted');
  if (b.submit) {
    if (!b.recommendation) throw bad('Choose a recommendation (Strong Hire, Hire, Hold or No Hire)');
    if (b.evidence.trim().length < 20) throw bad('Please add evidence-based notes (what you observed) before submitting');
    if (!Object.keys(b.ratings).length) throw bad('Rate at least one criterion');
  }
  await db.interview_feedback.upsert({ interview_id: i.id, interviewer_id: req.auth!.userId },
    { ratings: JSON.stringify(b.ratings), evidence: b.evidence, private_notes: b.private_notes, recommendation: b.recommendation, submitted: +b.submit, updated_at: now() },
    { id: uid(), company_id: cid, created_at: now() });
  if (b.submit) {
    await audit(cid, req.auth!, 'feedback.submitted', i.id, req);
    const parts = await db.interview_participants.list({ interview_id: i.id }, { projection: { user_id: 1 } });
    const submittedBy = new Set((await db.interview_feedback.list({ interview_id: i.id, submitted: 1 }, { projection: { interviewer_id: 1 } })).map(f => f.interviewer_id));
    const remaining = parts.filter(p => !submittedBy.has(p.user_id)).length;
    if (remaining === 0) {
      for (const m of await db.company_members.list({ company_id: cid, role: { $in: ['hiring_manager', 'owner', 'admin'] }, status: 'active' }))
        await notify(cid, m.user_id, 'decision', `All feedback is in: ${i.title}`, 'Review the consolidated feedback and make a decision.', `/interviews/${i.id}/feedback`);
    }
  }
  res.json({ ok: true });
}));

evalRouter.get('/interviews/:id/consolidated', requirePerm('feedback.viewAll'), wrap(async (req, res) => {
  const i = await iv(req);
  const rows = await db.interview_feedback.list({ interview_id: i.id, company_id: tenant(req), submitted: 1 }, { projection: { ratings: 1, recommendation: 1 } });
  const sums: Record<string, { total: number; n: number }> = {}; const recs: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(j<Record<string, number>>(r.ratings, {}))) { (sums[k] ||= { total: 0, n: 0 }).total += v; sums[k].n++; }
    if (r.recommendation) recs[r.recommendation] = (recs[r.recommendation] || 0) + 1;
  }
  res.json({ submitted: rows.length, averages: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round((v.total / v.n) * 10) / 10])), recommendations: recs,
    note: 'Averages summarise interviewer ratings. They are an aid, not a decision. A human hiring manager makes the final call.' });
}));

/* =============== TRANSCRIPTS =============== */
evalRouter.post('/interviews/:id/transcript', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const i = await iv(req);
  const b = parse(z.object({ segments: z.array(z.object({ speaker: z.string().max(60).default('Speaker'), text: z.string().trim().min(1).max(4000), offset_sec: z.number().min(0).default(0) })).min(1).max(500) }), req.body);
  await db.interview_transcripts.insertMany(b.segments.map(s => ({ company_id: tenant(req), interview_id: i.id, speaker: s.speaker, text: s.text, offset_sec: s.offset_sec, source: 'manual', created_at: now() })));
  res.status(201).json({ ok: true, count: b.segments.length });
}));
/** Automatic speech-to-text of a consented, completed recording. Output is a labelled machine transcript; no speaker identity, emotion or accent analysis. */
evalRouter.post('/interviews/:id/recordings/:rid/transcribe', requirePerm('interviews.conduct'), wrap(async (req, res) => {
  const i = await iv(req); const cid = tenant(req);
  if (!(await isParticipant(i.id, req.auth!.userId)) && !['owner', 'admin'].includes(req.auth!.role!)) throw new HttpError(403, 'Not a participant');
  if (!config.stt.baseUrl || !config.stt.apiKey) throw new HttpError(501, 'Speech-to-text is not configured on this server (set STT_BASE_URL and STT_API_KEY).', 'stt_not_configured');
  const s = await aiGate(req);
  void s;
  const r = await db.interview_recordings.get({ id: String(req.params.rid), interview_id: i.id, company_id: cid });
  if (!r || r.status !== 'ready' || !r.file_key) throw notFound('Recording not found or not ready');
  if (r.source === 'secondary_camera') throw bad('The secondary camera is video-only and has no audio to transcribe.');
  const rec = await db.consent_records.get({ interview_id: i.id, company_id: cid, kind: 'recording' }, { sort: { created_at: -1 } });
  if (!rec?.granted) throw new HttpError(403, 'Recording consent is not on record, so this recording cannot be processed.', 'no_consent');
  if (r.size > config.stt.maxBytes) throw bad(`Recording is larger than the ${Math.round(config.stt.maxBytes / 1048576)} MB speech-to-text limit.`, 'too_large');
  const buf = fs.readFileSync(safeKey(r.file_key));
  const form = new FormData();
  form.append('file', new Blob([buf], { type: r.mime || 'video/webm' }), `recording.${(r.mime || '').includes('mp4') ? 'mp4' : 'webm'}`);
  form.append('model', config.stt.model);
  form.append('response_format', 'verbose_json');
  let data: any;
  try {
    const resp = await fetch(`${config.stt.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${config.stt.apiKey}` }, body: form, signal: AbortSignal.timeout(300_000) });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    data = await resp.json();
  } catch (e: any) { throw new HttpError(502, `The speech-to-text provider failed (${e.message}). Nothing was saved.`, 'stt_failed'); }
  const segs: Array<{ text: string; start: number }> = (Array.isArray(data.segments) ? data.segments : []).map((g: any) => ({ text: String(g.text || '').trim(), start: Number(g.start) || 0 }))
    .filter((g: any) => g.text);
  if (!segs.length && typeof data.text === 'string' && data.text.trim()) segs.push({ text: data.text.trim(), start: 0 });
  if (!segs.length) throw bad('No speech was detected in this recording.', 'no_speech');
  await tx(async () => {
    await db.interview_transcripts.del({ interview_id: i.id, company_id: cid, source: `stt:${r.id}` });
    await db.interview_transcripts.insertMany(segs.map(g => ({ company_id: cid, interview_id: i.id, speaker: 'Speaker', text: g.text.slice(0, 4000), offset_sec: g.start, source: `stt:${r.id}`, created_at: now() })));
  });
  await recordUsage(cid, 'ai_calls', 1, r.id);
  await audit(cid, req.auth!, 'transcript.generated', i.id, req, { recording: r.id, segments: segs.length });
  res.status(201).json({ ok: true, count: segs.length, notice: 'Machine-generated transcript. It may contain errors and does not identify speakers; review before relying on it.' });
}));

evalRouter.get('/interviews/:id/transcript', requirePerm('recordings.view'), wrap(async (req, res) => {
  const i = await iv(req);
  const rows = await db.interview_transcripts.list({ interview_id: i.id, company_id: tenant(req) }, { sort: { offset_sec: 1, created_at: 1, _seq: 1 } });
  res.json({ items: rows.map(r => ({ speaker: r.speaker, text: r.text, offset_sec: r.offset_sec, source: r.source })) });
}));

/* =============== AI ASSISTANCE =============== */
const DISCLAIMER = 'AI-generated draft. It may be incomplete or wrong, was produced without seeing the candidate, and must be reviewed and edited by a human. It does not assess personality, emotion or any protected characteristic and must not be used as the sole basis for a hiring decision.';

async function aiGate(req: any) {
  const cid = tenant(req);
  const co = await db.companies.get({ id: cid });
  const s = j(co.settings, {} as any);
  if (s.aiEnabled === false) throw new HttpError(403, 'AI features are turned off for your company (Settings → AI & data).', 'ai_disabled');
  await enforce(cid, { feature: 'ai', metric: 'ai_calls', limitKey: 'ai_calls_per_month' });
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

async function save(cid: string, kind: string, content: any, provider: string, userId: string, interviewId?: string, jobId?: string) {
  const id = uid();
  await db.ai_reports.insert({ id, company_id: cid, interview_id: interviewId ?? null, job_id: jobId ?? null, kind, content: JSON.stringify(content), provider, created_by: userId, created_at: now() });
  await recordUsage(cid, 'ai_calls', 1, id);
  return id;
}
const out = (id: string, kind: string, provider: string, content: any) => ({ id, kind, aiGenerated: true, provider, disclaimer: DISCLAIMER, content });

evalRouter.post('/ai/questions', requirePerm('ai.use'), wrap(async (req, res) => {
  const s = await aiGate(req);
  const b = parse(z.object({ jobId: z.string(), count: z.number().int().min(3).max(15).default(8), focus: z.string().max(200).optional() }), req.body);
  const job = await db.jobs.get({ id: b.jobId, company_id: tenant(req) });
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
  res.json(out(await save(tenant(req), 'questions', content, provider, req.auth!.userId, undefined, job.id), 'questions', provider, content));
  void s;
}));

async function interviewContext(i: any, cid: string, minimise: boolean) {
  const app = await db.applications.get({ id: i.application_id, company_id: cid });
  const cRow = app ? await db.candidates.get({ id: app.candidate_id, company_id: cid }) : null;
  const cand = { name: cRow.name as string, job_id: app.job_id as string };
  const job = await db.jobs.get({ id: cand.job_id, company_id: cid });
  const pick = <T extends object>(rows: any[], keys: string[]) => rows.map(r => Object.fromEntries(keys.map(k => [k, r[k]])) as any);
  const transcript = pick(await db.interview_transcripts.list({ interview_id: i.id, company_id: cid }, { sort: { offset_sec: 1, created_at: 1, _seq: 1 } }), ['speaker', 'text']);
  const chat = pick(await db.chat_messages.list({ interview_id: i.id, company_id: cid }, { sort: { created_at: 1, _seq: 1 } }), ['sender_name', 'body']);
  const subs = pick(await db.coding_submissions.list({ interview_id: i.id, company_id: cid, kind: 'submit' }, { sort: { created_at: 1, _seq: 1 } }), ['passed', 'total', 'score', 'language']);
  const events = pick(await db.recording_events.list({ interview_id: i.id, company_id: cid, kind: { $not: { $regex: '^signal:' } } }, { sort: { offset_sec: 1, _seq: 1 } }), ['kind', 'label', 'offset_sec']);
  const mask = (s: string) => (minimise ? s.split(cand.name).join('the candidate') : s);
  return { cand, job, skills: j<string[]>(job.required_skills, []), transcript: transcript.map(t => ({ speaker: mask(t.speaker), text: mask(t.text) })), chat, subs, events };
}

const topicsIn = (text: string, skills: string[]) => skills.filter(s => new RegExp(`\\b${s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));

evalRouter.post('/interviews/:id/ai/summary', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = await iv(req); const s = await aiGate(req);
  const ctx = await interviewContext(i, tenant(req), s.aiDataMinimization !== false);
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
  res.json(out(await save(tenant(req), 'summary', content, provider, req.auth!.userId, i.id), 'summary', provider, content));
}));

evalRouter.post('/interviews/:id/ai/followups', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = await iv(req); const s = await aiGate(req);
  const b = parse(z.object({ context: z.string().trim().min(5).max(3000) }), req.body);
  let provider = 'rule-based'; let list: string[] | null = null;
  const r = await callProvider(SYSTEM + ' Reply as JSON: {"followups":["..."]}', `Candidate's answer or topic:\n${b.context}\nSuggest 4 follow-up probing questions.`);
  if (r) { try { list = JSON.parse(r.match(/\{[\s\S]*\}/)![0]).followups; provider = config.ai.model; } catch { list = null; } }
  if (!list) list = ['Can you give a concrete example from your own work?', 'What trade-offs did you consider and why did you choose this approach?', 'How would this change at 100× the scale?', 'What would you do differently if you did it again?'];
  void s;
  const content = { followups: list };
  res.json(out(await save(tenant(req), 'followups', content, provider, req.auth!.userId, i.id), 'followups', provider, content));
}));

evalRouter.post('/interviews/:id/ai/feedback-draft', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = await iv(req); const s = await aiGate(req);
  const ctx = await interviewContext(i, tenant(req), s.aiDataMinimization !== false);
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
  res.json(out(await save(tenant(req), 'feedback_draft', content, provider, req.auth!.userId, i.id), 'feedback_draft', provider, content));
}));

evalRouter.post('/interviews/:id/ai/coding-summary', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = await iv(req); await aiGate(req);
  const subs = (await db.coding_submissions.list({ interview_id: i.id, company_id: tenant(req), kind: 'submit' }, { sort: { created_at: 1, _seq: 1 } }))
    .map(s => ({ language: s.language, passed: s.passed, total: s.total, score: s.score, created_at: s.created_at }));
  const runs = await db.coding_submissions.count({ interview_id: i.id, company_id: tenant(req), kind: 'run' });
  if (!subs.length && !runs) throw bad('No coding activity recorded for this interview');
  const best = subs.reduce((m, s) => (s.score > (m?.score ?? -1) ? s : m), null as any);
  const content = {
    summary: `${runs} test runs and ${subs.length} submissions. ` + (best ? `Best submission: ${best.passed}/${best.total} tests passed (${best.score}%) in ${best.language}.` : 'No graded submission.'),
    submissions: subs, note: 'Computed from recorded test results. Review the code history in the playback view for approach and quality.',
  };
  res.json(out(await save(tenant(req), 'coding_summary', content, 'computed', req.auth!.userId, i.id), 'coding_summary', 'computed', content));
}));

evalRouter.get('/interviews/:id/ai-reports', requirePerm('ai.use'), wrap(async (req, res) => {
  const i = await iv(req);
  const rows = (await db.ai_reports.list({ interview_id: i.id, company_id: tenant(req) }, { sort: { created_at: -1 } })).map(r => ({ id: r.id, kind: r.kind, content: r.content, provider: r.provider, created_at: r.created_at }));
  res.json({ disclaimer: DISCLAIMER, items: rows.map(r => ({ ...r, content: j(r.content, {}), aiGenerated: true })) });
}));
