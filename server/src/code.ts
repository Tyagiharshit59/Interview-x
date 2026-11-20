import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { db, uid, now, j } from './db.js';

export const LANGUAGES: Record<string, { label: string; judge0: number | null; monaco: string; ext: string; runnable: boolean }> = {
  javascript: { label: 'JavaScript (Node.js)', judge0: 63, monaco: 'javascript', ext: 'js', runnable: true },
  typescript: { label: 'TypeScript', judge0: 74, monaco: 'typescript', ext: 'ts', runnable: true },
  python: { label: 'Python', judge0: 71, monaco: 'python', ext: 'py', runnable: true },
  java: { label: 'Java', judge0: 62, monaco: 'java', ext: 'java', runnable: true },
  php: { label: 'PHP', judge0: 68, monaco: 'php', ext: 'php', runnable: true },
  c: { label: 'C', judge0: 50, monaco: 'c', ext: 'c', runnable: true },
  cpp: { label: 'C++', judge0: 54, monaco: 'cpp', ext: 'cpp', runnable: true },
  csharp: { label: 'C#', judge0: 51, monaco: 'csharp', ext: 'cs', runnable: true },
  sql: { label: 'SQL (SQLite)', judge0: 82, monaco: 'sql', ext: 'sql', runnable: true },
  go: { label: 'Go', judge0: 60, monaco: 'go', ext: 'go', runnable: true },
  ruby: { label: 'Ruby', judge0: 72, monaco: 'ruby', ext: 'rb', runnable: true },
  rust: { label: 'Rust', judge0: 73, monaco: 'rust', ext: 'rs', runnable: true },
  kotlin: { label: 'Kotlin', judge0: 78, monaco: 'kotlin', ext: 'kt', runnable: true },
  html: { label: 'HTML', judge0: null, monaco: 'html', ext: 'html', runnable: false },
  css: { label: 'CSS', judge0: null, monaco: 'css', ext: 'css', runnable: false },
};

export interface RunResult { status: string; ok: boolean; stdout: string; stderr: string; compileOutput: string; timeMs: number | null; memoryKb: number | null }

export function runnerInfo() {
  return { mode: config.runner.mode, ready: config.runner.mode === 'judge0' ? !!config.runner.judge0Url : config.runner.mode === 'dev-local' && !config.isProd };
}

/**
 * Untrusted code NEVER runs inside the API process. 'judge0' sends it to an isolated, resource-limited
 * Judge0 deployment (credentials stay server-side). 'dev-local' spawns a child process with a timeout and is
 * NOT a sandbox: it is refused in production.
 */
export async function runCode(language: string, code: string, stdin: string, timeLimitSec = 5): Promise<RunResult> {
  const lang = LANGUAGES[language];
  if (!lang) return fail('Unsupported language');
  if (!lang.runnable) return fail(`${lang.label} cannot be executed; use the live preview instead.`);
  if (code.length > 100_000) return fail('Source is too large (100 KB max).');
  if (config.runner.mode === 'judge0') return runJudge0(lang.judge0!, code, stdin, timeLimitSec);
  if (config.runner.mode === 'dev-local' && !config.isProd) return runLocal(language, code, stdin, timeLimitSec);
  return fail('Code execution is not configured. Set CODE_RUNNER=judge0 and JUDGE0_URL (see README).');
}
const fail = (msg: string): RunResult => ({ status: 'Unavailable', ok: false, stdout: '', stderr: msg, compileOutput: '', timeMs: null, memoryKb: null });

async function runJudge0(languageId: number, code: string, stdin: string, timeLimitSec: number): Promise<RunResult> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.runner.judge0Key) headers['X-Auth-Token'] = config.runner.judge0Key;
    const r = await fetch(`${config.runner.judge0Url.replace(/\/$/, '')}/submissions?base64_encoded=false&wait=true`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ source_code: code, language_id: languageId, stdin, cpu_time_limit: timeLimitSec, wall_time_limit: timeLimitSec * 3, memory_limit: 256000 }),
    });
    if (!r.ok) return fail(`Execution service error (${r.status})`);
    const d: any = await r.json();
    return {
      status: d.status?.description || 'Unknown', ok: d.status?.id === 3, stdout: d.stdout || '', stderr: d.stderr || d.message || '', compileOutput: d.compile_output || '',
      timeMs: d.time != null ? Math.round(Number(d.time) * 1000) : null, memoryKb: d.memory ?? null,
    };
  } catch (e: any) { return fail(e?.name === 'TimeoutError' ? 'Execution service timed out' : 'Execution service unreachable'); }
}

function runLocal(language: string, code: string, stdin: string, timeLimitSec: number): Promise<RunResult> {
  const cmd = language === 'javascript' ? ['node'] : language === 'python' ? [process.platform === 'win32' ? 'python' : 'python3'] : null;
  if (!cmd) return Promise.resolve(fail('dev-local runner only supports JavaScript and Python. Use Judge0 for other languages.'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivx-'));
  const file = path.join(dir, 'main.' + LANGUAGES[language].ext);
  fs.writeFileSync(file, code);
  const t0 = Date.now();
  return new Promise(resolve => {
    const p = spawn(cmd[0], [file], { cwd: dir, env: { PATH: process.env.PATH || '' }, windowsHide: true });
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeLimitSec * 1000);
    p.stdout.on('data', d => { if (out.length < 100_000) out += d; });
    p.stderr.on('data', d => { if (err.length < 100_000) err += d; });
    p.on('error', e => { clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true }); resolve(fail(`Cannot start ${cmd[0]}: ${e.message}`)); });
    p.on('close', c => {
      clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true });
      resolve({ status: killed ? 'Time Limit Exceeded' : c === 0 ? 'Accepted' : 'Runtime Error', ok: !killed && c === 0, stdout: out, stderr: err, compileOutput: '', timeMs: Date.now() - t0, memoryKb: null });
    });
    p.stdin.on('error', () => { /* ignore EPIPE */ });
    p.stdin.end(stdin);
  });
}

const norm = (s: string) => s.replace(/\r/g, '').split('\n').map(l => l.trimEnd()).join('\n').trim();

export interface TestOutcome { id: string; hidden: boolean; passed: boolean; status: string; input?: string; expected?: string; actual?: string; timeMs: number | null }

export async function runTests(companyId: string, questionId: string, language: string, code: string, opts: { revealHidden: boolean }) {
  const q = await db.coding_questions.get({ id: questionId, company_id: companyId });
  if (!q) throw new Error('Question not found');
  const cases = await db.coding_test_cases.list({ question_id: questionId, company_id: companyId }, { sort: { _seq: 1 } });
  const outcomes: TestOutcome[] = [];
  let earned = 0, totalW = 0;
  for (const c of cases) {
    const r = await runCode(language, code, c.input, q.time_limit_sec);
    const passed = r.ok && norm(r.stdout) === norm(c.expected_output);
    totalW += c.weight; if (passed) earned += c.weight;
    const hidden = !!c.is_hidden;
    outcomes.push({
      id: c.id, hidden, passed, status: r.ok ? (passed ? 'Passed' : 'Wrong Answer') : r.status, timeMs: r.timeMs,
      ...(!hidden || opts.revealHidden ? { input: c.input, expected: c.expected_output, actual: (r.stdout || r.stderr || r.compileOutput).slice(0, 2000) } : {}),
    });
  }
  return { outcomes, passed: outcomes.filter(o => o.passed).length, total: outcomes.length, score: totalW ? Math.round((earned / totalW) * 100) : 0 };
}

export async function logExecution(companyId: string, interviewId: string | null, language: string, r: RunResult) {
  await db.coding_execution_logs.insert({ company_id: companyId, interview_id: interviewId, language, status: r.status, time_ms: r.timeMs, memory_kb: r.memoryKb, stdout: r.stdout.slice(0, 4000), stderr: (r.stderr + r.compileOutput).slice(0, 4000), created_at: now() });
}
export { j };
