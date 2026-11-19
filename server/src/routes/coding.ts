import { Router } from 'express';
import { z } from 'zod';
import { db, uid, now, j } from '../db.js';
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

const qOut = (q: any, staff = true) => ({ ...q, languages: j(q.languages, []), starter_code: j(q.starter_code, {}), tests: undefined });

codingRouter.get('/questions', wrap((req, res) => {
  const { q, kind, difficulty } = req.query as Record<string, string | undefined>;
  let sql = 'SELECT qs.*, (SELECT COUNT(*) FROM coding_test_cases t WHERE t.question_id=qs.id) test_count FROM coding_questions qs WHERE company_id=?';
  const args: any[] = [tenant(req)];
  if (q) { sql += ' AND (title LIKE ? OR category LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  if (kind) { sql += ' AND kind=?'; args.push(kind); }
  if (difficulty) { sql += ' AND difficulty=?'; args.push(difficulty); }
  res.json({ items: (db.prepare(sql + ' ORDER BY created_at DESC LIMIT 300').all(...args) as any[]).map(r => qOut(r)) });
}));

codingRouter.get('/questions/:id', wrap((req, res) => {
  const q = db.prepare('SELECT * FROM coding_questions WHERE id=? AND company_id=?').get(req.params.id, tenant(req)) as any;
  if (!q) throw notFound();
  const tests = db.prepare('SELECT id,input,expected_output,is_hidden,weight FROM coding_test_cases WHERE question_id=? AND company_id=? ORDER BY rowid').all(q.id, tenant(req)) as any[];
  res.json({ ...qOut(q), tests: tests.map(t => ({ ...t, is_hidden: !!t.is_hidden })) });
}));

function saveTests(cid: string, qid: string, tests: z.infer<typeof qBody>['tests']) {
  db.prepare('DELETE FROM coding_test_cases WHERE question_id=? AND company_id=?').run(qid, cid);
  for (const t of tests) db.prepare('INSERT INTO coding_test_cases(id,company_id,question_id,input,expected_output,is_hidden,weight) VALUES (?,?,?,?,?,?,?)').run(uid(), cid, qid, t.input, t.expected_output, +t.is_hidden, t.weight);
}

codingRouter.post('/questions', requirePerm('questions.write'), wrap((req, res) => {
  const b = parse(qBody, req.body);
  const id = uid();
  db.transaction(() => {
    db.prepare('INSERT INTO coding_questions(id,company_id,title,prompt,difficulty,category,languages,starter_code,time_limit_sec,scoring_criteria,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, tenant(req), b.title, b.prompt, b.difficulty, b.category ?? null, JSON.stringify(b.languages), JSON.stringify(b.starter_code), b.time_limit_sec, b.scoring_criteria ?? null, b.kind, req.auth!.userId, now());
    saveTests(tenant(req), id, b.tests);
  })();
  audit(tenant(req), req.auth!, 'question.created', id, req);
  res.status(201).json({ id });
}));

codingRouter.put('/questions/:id', requirePerm('questions.write'), wrap((req, res) => {
  const cur = db.prepare('SELECT id FROM coding_questions WHERE id=? AND company_id=?').get(req.params.id, tenant(req));
  if (!cur) throw notFound();
  const b = parse(qBody, req.body);
  db.transaction(() => {
    db.prepare('UPDATE coding_questions SET title=?,prompt=?,difficulty=?,category=?,languages=?,starter_code=?,time_limit_sec=?,scoring_criteria=?,kind=? WHERE id=? AND company_id=?')
      .run(b.title, b.prompt, b.difficulty, b.category ?? null, JSON.stringify(b.languages), JSON.stringify(b.starter_code), b.time_limit_sec, b.scoring_criteria ?? null, b.kind, req.params.id, tenant(req));
    saveTests(tenant(req), String(req.params.id), b.tests);
  })();
  res.json({ ok: true });
}));

codingRouter.delete('/questions/:id', requirePerm('questions.write'), wrap((req, res) => {
  db.prepare('DELETE FROM coding_questions WHERE id=? AND company_id=?').run(req.params.id, tenant(req));
  res.json({ ok: true });
}));

/* ---------- evaluation templates ---------- */
export const DEFAULT_CRITERIA = ['Technical knowledge', 'Programming skills', 'Problem solving', 'Communication', 'Logical thinking', 'Practical experience', 'Code quality'];
codingRouter.get('/evaluation-template', wrap((req, res) => {
  const t = db.prepare('SELECT * FROM evaluation_templates WHERE company_id=? ORDER BY created_at DESC LIMIT 1').get(tenant(req)) as any;
  res.json({ criteria: t ? j(t.criteria, DEFAULT_CRITERIA) : DEFAULT_CRITERIA, custom: !!t });
}));
codingRouter.put('/evaluation-template', requirePerm('company.manage'), wrap((req, res) => {
  const { criteria } = parse(z.object({ criteria: z.array(z.string().trim().min(2).max(60)).min(1).max(15) }), req.body);
  db.prepare('INSERT INTO evaluation_templates(id,company_id,name,criteria,created_at) VALUES (?,?,?,?,?)').run(uid(), tenant(req), 'Default', JSON.stringify(criteria), now());
  res.json({ ok: true });
}));

/** Seeded starter questions so a new company has something to use. */
export function seedStarterQuestions(companyId: string, userId: string) {
  const mk = (title: string, prompt: string, diff: string, starter: Record<string, string>, tests: Array<[string, string, boolean]>) => {
    const id = uid();
    db.prepare('INSERT INTO coding_questions(id,company_id,title,prompt,difficulty,category,languages,starter_code,time_limit_sec,kind,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, companyId, title, prompt, diff, 'Algorithms', JSON.stringify(['javascript', 'python']), JSON.stringify(starter), 2, 'coding', userId, now());
    tests.forEach(([i, o, h]) => db.prepare('INSERT INTO coding_test_cases(id,company_id,question_id,input,expected_output,is_hidden,weight) VALUES (?,?,?,?,?,?,1)').run(uid(), companyId, id, i, o, +h));
  };
  mk('Two Sum', 'Read n, then n integers on the next line, then a target. Print the two 0-based indices (space separated, smaller first) of numbers that add up to the target.\n\nInput:\n4\n2 7 11 15\n9\nOutput:\n0 1', 'easy',
    { javascript: "const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');\nconst nums = lines[1].split(' ').map(Number);\nconst target = Number(lines[2]);\n// TODO: print the indices\n", python: "import sys\nlines = sys.stdin.read().strip().split('\\n')\nnums = list(map(int, lines[1].split()))\ntarget = int(lines[2])\n# TODO: print the indices\n" },
    [['4\n2 7 11 15\n9', '0 1', false], ['3\n3 2 4\n6', '1 2', false], ['2\n3 3\n6', '0 1', true], ['5\n1 5 9 14 20\n29', '2 4', true]]);
  mk('FizzBuzz', 'Read n. For each i from 1 to n print Fizz if divisible by 3, Buzz if by 5, FizzBuzz if both, otherwise the number. One per line.', 'easy',
    { javascript: "const n = Number(require('fs').readFileSync(0, 'utf8').trim());\n// TODO\n", python: "n = int(input())\n# TODO\n" },
    [['5', '1\n2\nFizz\n4\nBuzz', false], ['15', '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz', true]]);
  mk('Design a URL shortener', 'Discuss and sketch the architecture of a URL shortening service: APIs, data model, ID generation, caching, scaling and failure modes. Use the whiteboard.', 'medium', {}, []);
  db.prepare("UPDATE coding_questions SET kind='system_design' WHERE company_id=? AND title='Design a URL shortener'").run(companyId);
}
