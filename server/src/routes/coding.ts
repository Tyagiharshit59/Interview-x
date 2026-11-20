import { Router } from 'express';
import { z } from 'zod';
import { db, now, j, tx } from '../db.js';
import { requirePerm, tenant } from '../auth.js';
import { wrap, parse, notFound } from '../util.js';
import { audit } from '../services.js';
import { LANGUAGES, runnerInfo } from '../code.js';

export const codingRouter = Router();

codingRouter.get('/coding/languages', wrap((_req, res) => res.json({ languages: Object.entries(LANGUAGES).map(([id, v]) => ({ id, ...v, judge0: undefined })), runner: runnerInfo() })));

const qBody = z.object({
  title: z.string().trim().min(2).max(150), prompt: z.string().trim().min(5).max(10000), difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  category: z.string().max(60).nullish(), languages: z.array(z.string()).default([]), starter_code: z.record(z.string(), z.string().max(20000)).default({}),
  time_limit_sec: z.number().int().min(1).max(15).default(2), scoring_criteria: z.string().max(3000).nullish(), kind: z.enum(['coding', 'system_design', 'concept']).default('coding'),
  tests: z.array(z.object({ input: z.string().max(20000).default(''), expected_output: z.string().max(20000).default(''), is_hidden: z.boolean().default(false), weight: z.number().int().min(1).max(100).default(1) })).max(50).default([]),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const qOut = (q: any, staff = true) => ({ ...q, languages: j(q.languages, []), starter_code: j(q.starter_code, {}), tests: undefined });

codingRouter.get('/questions', wrap(async (req, res) => {
  const { q, kind, difficulty } = req.query as Record<string, string | undefined>;
  const cid = tenant(req);
  const filter: any = { company_id: cid };
  if (q) { const rx = { $regex: escapeRegex(q), $options: 'i' }; filter.$or = [{ title: rx }, { category: rx }]; }
  if (kind) filter.kind = kind;
  if (difficulty) filter.difficulty = difficulty;
  const rows = await db.coding_questions.list(filter, { sort: { created_at: -1 }, limit: 300 });
  const counts = rows.length ? await db.coding_test_cases.aggregate([{ $match: { company_id: cid, question_id: { $in: rows.map(r => r.id) } } }, { $group: { _id: '$question_id', n: { $sum: 1 } } }]) : [];
  const byQ = new Map<string, number>(counts.map((c: any) => [c._id, c.n]));
  res.json({ items: rows.map(r => qOut({ ...r, test_count: byQ.get(r.id) ?? 0 })) });
}));

codingRouter.get('/questions/:id', wrap(async (req, res) => {
  const q = await db.coding_questions.get({ id: req.params.id, company_id: tenant(req) });
  if (!q) throw notFound();
  const tests = await db.coding_test_cases.list({ question_id: q.id, company_id: tenant(req) }, { sort: { _seq: 1 } });
  res.json({ ...qOut(q), tests: tests.map(t => ({ id: t.id, input: t.input, expected_output: t.expected_output, is_hidden: !!t.is_hidden, weight: t.weight })) });
}));

async function saveTests(cid: string, qid: string, tests: z.infer<typeof qBody>['tests']) {
  await db.coding_test_cases.del({ question_id: qid, company_id: cid });
  for (const t of tests) await db.coding_test_cases.insert({ company_id: cid, question_id: qid, input: t.input, expected_output: t.expected_output, is_hidden: +t.is_hidden, weight: t.weight });
}

codingRouter.post('/questions', requirePerm('questions.write'), wrap(async (req, res) => {
  const b = parse(qBody, req.body);
  let id = '';
  await tx(async () => {
    id = await db.coding_questions.insert({
      company_id: tenant(req), title: b.title, prompt: b.prompt, difficulty: b.difficulty, category: b.category ?? null, languages: JSON.stringify(b.languages),
      starter_code: JSON.stringify(b.starter_code), time_limit_sec: b.time_limit_sec, scoring_criteria: b.scoring_criteria ?? null, kind: b.kind, created_by: req.auth!.userId, created_at: now(),
    });
    await saveTests(tenant(req), id, b.tests);
  });
  await audit(tenant(req), req.auth!, 'question.created', id, req);
  res.status(201).json({ id });
}));

codingRouter.put('/questions/:id', requirePerm('questions.write'), wrap(async (req, res) => {
  const cur = await db.coding_questions.get({ id: req.params.id, company_id: tenant(req) });
  if (!cur) throw notFound();
  const b = parse(qBody, req.body);
  await tx(async () => {
    await db.coding_questions.set({ id: String(req.params.id), company_id: tenant(req) }, {
      title: b.title, prompt: b.prompt, difficulty: b.difficulty, category: b.category ?? null, languages: JSON.stringify(b.languages), starter_code: JSON.stringify(b.starter_code),
      time_limit_sec: b.time_limit_sec, scoring_criteria: b.scoring_criteria ?? null, kind: b.kind,
    });
    await saveTests(tenant(req), String(req.params.id), b.tests);
  });
  res.json({ ok: true });
}));

codingRouter.delete('/questions/:id', requirePerm('questions.write'), wrap(async (req, res) => {
  await tx(async () => {
    const n = await db.coding_questions.del({ id: req.params.id, company_id: tenant(req) });
    if (n) await db.coding_test_cases.del({ question_id: String(req.params.id), company_id: tenant(req) }); // no FK cascade in MongoDB
  });
  res.json({ ok: true });
}));

/* ---------- evaluation templates ---------- */
export const DEFAULT_CRITERIA = ['Technical knowledge', 'Programming skills', 'Problem solving', 'Communication', 'Logical thinking', 'Practical experience', 'Code quality'];
codingRouter.get('/evaluation-template', wrap(async (req, res) => {
  const t = await db.evaluation_templates.get({ company_id: tenant(req) }, { sort: { created_at: -1, _seq: -1 } });
  res.json({ criteria: t ? j(t.criteria, DEFAULT_CRITERIA) : DEFAULT_CRITERIA, custom: !!t });
}));
codingRouter.put('/evaluation-template', requirePerm('company.manage'), wrap(async (req, res) => {
  const { criteria } = parse(z.object({ criteria: z.array(z.string().trim().min(2).max(60)).min(1).max(15) }), req.body);
  await db.evaluation_templates.insert({ company_id: tenant(req), name: 'Default', criteria: JSON.stringify(criteria), created_at: now() });
  res.json({ ok: true });
}));

/** Seeded starter questions so a new company has something to use. */
export async function seedStarterQuestions(companyId: string, userId: string) {
  const mk = async (title: string, prompt: string, diff: string, starter: Record<string, string>, tests: Array<[string, string, boolean]>) => {
    const id = await db.coding_questions.insert({
      company_id: companyId, title, prompt, difficulty: diff, category: 'Algorithms', languages: JSON.stringify(['javascript', 'python']), starter_code: JSON.stringify(starter),
      time_limit_sec: 2, scoring_criteria: null, kind: 'coding', created_by: userId, created_at: now(),
    });
    for (const [i, o, h] of tests) await db.coding_test_cases.insert({ company_id: companyId, question_id: id, input: i, expected_output: o, is_hidden: +h, weight: 1 });
  };
  await mk('Two Sum', 'Read n, then n integers on the next line, then a target. Print the two 0-based indices (space separated, smaller first) of numbers that add up to the target.\n\nInput:\n4\n2 7 11 15\n9\nOutput:\n0 1', 'easy',
    { javascript: "const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');\nconst nums = lines[1].split(' ').map(Number);\nconst target = Number(lines[2]);\n// TODO: print the indices\n", python: "import sys\nlines = sys.stdin.read().strip().split('\\n')\nnums = list(map(int, lines[1].split()))\ntarget = int(lines[2])\n# TODO: print the indices\n" },
    [['4\n2 7 11 15\n9', '0 1', false], ['3\n3 2 4\n6', '1 2', false], ['2\n3 3\n6', '0 1', true], ['5\n1 5 9 14 20\n29', '2 4', true]]);
  await mk('FizzBuzz', 'Read n. For each i from 1 to n print Fizz if divisible by 3, Buzz if by 5, FizzBuzz if both, otherwise the number. One per line.', 'easy',
    { javascript: "const n = Number(require('fs').readFileSync(0, 'utf8').trim());\n// TODO\n", python: "n = int(input())\n# TODO\n" },
    [['5', '1\n2\nFizz\n4\nBuzz', false], ['15', '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz', true]]);
  await mk('Design a URL shortener', 'Discuss and sketch the architecture of a URL shortening service: APIs, data model, ID generation, caching, scaling and failure modes. Use the whiteboard.', 'medium', {}, []);
  await db.coding_questions.setMany({ company_id: companyId, title: 'Design a URL shortener' }, { kind: 'system_design' });
}
