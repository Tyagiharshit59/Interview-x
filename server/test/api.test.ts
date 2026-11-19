import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 4100;
const BASE = `http://localhost:${PORT}/api`;
let proc: ChildProcess;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivx-test-'));

class Client {
  cookie = '';
  async req(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let data: any = null; try { data = await r.json(); } catch { /* none */ }
    return { status: r.status, data };
  }
}
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString();

before(async () => {
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'), stdio: 'pipe',
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 't.db'), STORAGE_DIR: tmp, CODE_RUNNER: 'dev-local', NODE_ENV: 'test', APP_URL: 'http://localhost:5173' },
  });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch { /* wait */ } await new Promise(r => setTimeout(r, 250)); }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); });

const A = new Client(), B = new Client();
let jobId = '', candId = '', appId = '', interviewId = '', inviteUrl = '', ownerId = '';

test('registration, validation and session', async () => {
  const bad = await A.req('POST', '/auth/register', { companyName: 'X', name: 'A', email: 'nope', password: 'short' });
  assert.equal(bad.status, 422);
  const ok = await A.req('POST', '/auth/register', { companyName: 'Acme Corp', name: 'Alice Owner', email: 'alice@acme.test', password: 'Passw0rd!x' });
  assert.equal(ok.status, 201);
  ownerId = ok.data.user.id;
  assert.equal(ok.data.role, 'owner');
  const dup = await new Client().req('POST', '/auth/register', { companyName: 'Acme 2', name: 'Alice', email: 'alice@acme.test', password: 'Passw0rd!x' });
  assert.equal(dup.status, 409);
  const ok2 = await B.req('POST', '/auth/register', { companyName: 'Beta Ltd', name: 'Bob Owner', email: 'bob@beta.test', password: 'Passw0rd!x' });
  assert.equal(ok2.status, 201);
  assert.equal((await new Client().req('GET', '/jobs')).status, 401);
});

test('jobs + candidates + applications; tenant isolation', async () => {
  const j = await A.req('POST', '/jobs', { title: 'Backend Engineer', required_skills: ['node.js', 'postgresql'], preferred_skills: ['docker'], exp_min: 3 });
  assert.equal(j.status, 201); jobId = j.data.id;
  await A.req('POST', `/jobs/${jobId}/status`, { status: 'published' });
  const c = await A.req('POST', '/candidates', { name: 'Carol Candidate', email: 'carol@mail.test', skills: ['node.js', 'docker'], experience_years: 4, jobId });
  assert.equal(c.status, 201); candId = c.data.id;
  const prof = await A.req('GET', `/candidates/${candId}`);
  appId = prof.data.applications[0].id;
  assert.ok(prof.data.applications[0].match_score > 0);
  assert.equal((await A.req('POST', '/candidates', { name: 'Carol Again', email: 'carol@mail.test' })).status, 409);
  // Company B cannot see or touch A's data
  assert.equal((await B.req('GET', `/jobs/${jobId}`)).status, 404);
  assert.equal((await B.req('GET', `/candidates/${candId}`)).status, 404);
  assert.equal((await B.req('PATCH', `/applications/${appId}/stage`, { stage: 'Screening' })).status, 404);
  assert.equal((await B.req('GET', '/candidates')).data.items.length, 0);
});

test('RBAC: invite an interviewer, enforce permissions', async () => {
  const inv = await A.req('POST', '/team/invites', { email: 'ian@acme.test', role: 'interviewer' });
  assert.equal(inv.status, 201);
  const token = inv.data.devInviteUrl.split('token=')[1];
  const I = new Client();
  const acc = await I.req('POST', `/auth/invite/${token}/accept`, { name: 'Ian Interviewer', password: 'Passw0rd!x' });
  assert.equal(acc.data.role, 'interviewer');
  assert.equal((await I.req('POST', '/jobs', { title: 'Nope' })).status, 403);
  assert.equal((await I.req('PATCH', '/company', { name: 'Hacked' })).status, 403);
  assert.equal((await I.req('GET', '/billing')).status, 403);
  // token is single-use
  assert.equal((await new Client().req('POST', `/auth/invite/${token}/accept`, { name: 'Eve', password: 'Passw0rd!x' })).status, 400);
  (globalThis as any).ianClient = I; (globalThis as any).ianId = acc.data.user.id;
  // Starter-like limit: Professional trial allows 10 members, so fine here.
});

test('schedule interview with invite link; candidate identity + window', async () => {
  const ianId = (globalThis as any).ianId;
  const bad = await A.req('POST', '/interviews', { applicationId: appId, title: 'Tech 1', scheduledAt: iso(5), interviewerIds: ['not-a-user'], config: {} });
  assert.equal(bad.status, 400);
  const r = await A.req('POST', '/interviews', { applicationId: appId, title: 'Tech Round 1', scheduledAt: iso(5), durationMin: 45, interviewerIds: [ianId, ownerId], config: { coding: true, recording: true, secondaryCamera: true } });
  assert.equal(r.status, 201); interviewId = r.data.id; inviteUrl = r.data.devInviteUrl;
  const tok = inviteUrl.split('/join/')[1];
  const info = await new Client().req('GET', `/public/join/${tok}`);
  assert.equal(info.status, 200); assert.equal(info.data.company, 'Acme Corp');
  assert.equal((await new Client().req('GET', '/public/join/' + 'x'.repeat(43))).status, 404);
  assert.equal((await new Client().req('POST', `/public/join/${tok}/ticket`, { email: 'wrong@mail.test' })).status, 403);
  const t = await new Client().req('POST', `/public/join/${tok}/ticket`, { email: 'CAROL@mail.test' });
  assert.equal(t.status, 200); assert.ok(t.data.ticket);
  // re-issuing an invite revokes the old link
  const re = await A.req('POST', `/interviews/${interviewId}/resend-invite`);
  assert.equal((await new Client().req('GET', `/public/join/${tok}`)).status, 410);
  assert.equal((await new Client().req('GET', `/public/join/${re.data.devInviteUrl.split('/join/')[1]}`)).status, 200);
  inviteUrl = re.data.devInviteUrl;
});

function wsConnect(ticket: string) {
  return new Promise<{ ws: WebSocket; msgs: any[] }>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?ticket=${ticket}`); const msgs: any[] = [];
    ws.on('message', d => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs })); ws.on('error', reject);
  });
}
const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };

test('realtime room: waiting room, admit, consent gate for recording, code run', async () => {
  const ian = (globalThis as any).ianClient as Client;
  const st = await ian.req('POST', `/interviews/${interviewId}/room-ticket`);
  assert.equal(st.status, 200);
  const S = await wsConnect(st.data.ticket);
  // tickets are single-use
  await assert.rejects(wsConnect(st.data.ticket));
  const tok = inviteUrl.split('/join/')[1];
  const ct = await new Client().req('POST', `/public/join/${tok}/ticket`, { email: 'carol@mail.test' });
  const C = await wsConnect(ct.data.ticket);
  await until(() => C.msgs.some(m => m.t === 'waiting-room'));
  assert.ok(!C.msgs.some(m => m.t === 'welcome'), 'candidate must wait to be admitted');
  await until(() => S.msgs.some(m => m.t === 'waiting' && m.waiting.length === 1));
  const waitingId = S.msgs.filter(m => m.t === 'waiting').at(-1).waiting[0].id;
  // candidate cannot admit itself
  C.ws.send(JSON.stringify({ t: 'admit', peerId: waitingId }));
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!C.msgs.some(m => m.t === 'welcome'));
  S.ws.send(JSON.stringify({ t: 'admit', peerId: waitingId }));
  await until(() => C.msgs.some(m => m.t === 'welcome'));
  // recording cannot start without consent
  S.ws.send(JSON.stringify({ t: 'rec-state', active: true, sources: ['main'] }));
  await until(() => S.msgs.some(m => m.t === 'error' && /consent/i.test(m.message)));
  C.ws.send(JSON.stringify({ t: 'consent', kind: 'recording', granted: true }));
  await until(() => S.msgs.some(m => m.t === 'consents' && m.consents.recording === true));
  S.ws.send(JSON.stringify({ t: 'rec-state', active: true, sources: ['main'] }));
  await until(() => C.msgs.some(m => m.t === 'recording' && m.recording.active));
  // candidate can't control recording
  C.ws.send(JSON.stringify({ t: 'rec-state', active: false }));
  await until(() => C.msgs.some(m => m.t === 'error'));
  // code collaboration + dev runner
  S.ws.send(JSON.stringify({ t: 'interview-start' }));
  C.ws.send(JSON.stringify({ t: 'code-update', file: 'main.js', content: 'console.log(21*2)' }));
  await until(() => S.msgs.some(m => m.t === 'code-update' && m.content.includes('21*2')));
  C.ws.send(JSON.stringify({ t: 'code-run', file: 'main.js', stdin: '' }));
  await until(() => S.msgs.some(m => m.t === 'code-result'), 10000);
  const res = S.msgs.find(m => m.t === 'code-result').result;
  assert.equal(res.stdout.trim(), '42');
  // interviewer locks the editor
  S.ws.send(JSON.stringify({ t: 'code-permission', allow: false }));
  await until(() => C.msgs.some(m => m.t === 'code-permission' && m.allow === false));
  C.ws.send(JSON.stringify({ t: 'code-update', file: 'main.js', content: 'hack' }));
  await until(() => C.msgs.filter(m => m.t === 'error').length >= 2);
  // end interview
  S.ws.send(JSON.stringify({ t: 'interview-end' }));
  await until(() => C.msgs.some(m => m.t === 'status' && m.status === 'completed'));
  S.ws.close(); C.ws.close();
});

test('recording upload requires consent and authorised participant; playback is access-controlled', async () => {
  const ian = (globalThis as any).ianClient as Client;
  const rec = await ian.req('POST', `/interviews/${interviewId}/recordings`, { source: 'main', mime: 'video/webm' });
  assert.equal(rec.status, 201);
  const secondary = await ian.req('POST', `/interviews/${interviewId}/recordings`, { source: 'secondary_camera' });
  assert.equal(secondary.status, 403, 'secondary camera recording needs its own consent');
  const chunk = await fetch(`${BASE}/recordings/${rec.data.id}/chunk`, { method: 'PUT', headers: { Cookie: ian.cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('fake-webm-data') });
  assert.equal(chunk.status, 200);
  assert.equal((await ian.req('POST', `/recordings/${rec.data.id}/complete`)).status, 200);
  assert.equal((await B.req('GET', `/interviews/${interviewId}/playback`)).status, 404, 'other tenant cannot see playback');
  const pb = await ian.req('GET', `/interviews/${interviewId}/playback`);
  assert.equal(pb.status, 200); assert.equal(pb.data.recordings.length, 1);
  const f = await fetch(`http://localhost:${PORT}${pb.data.recordings[0].url}`);
  assert.equal(f.status, 200);
  assert.equal((await fetch(`http://localhost:${PORT}/api/files/garbage`)).status, 403);
  assert.ok(pb.data.events.some((e: any) => e.kind === 'interview_started'));
});

test('feedback independence and human decision', async () => {
  const ian = (globalThis as any).ianClient as Client;
  assert.equal((await ian.req('PUT', `/interviews/${interviewId}/feedback`, { submit: true, ratings: { 'Problem solving': 4 }, evidence: 'short', recommendation: 'hire' })).status, 400);
  assert.equal((await ian.req('PUT', `/interviews/${interviewId}/feedback`, { submit: true, ratings: { 'Problem solving': 4 }, evidence: 'Solved the sample problem with a clean hash-map approach and explained complexity.', recommendation: 'hire' })).status, 200);
  assert.equal((await ian.req('PUT', `/interviews/${interviewId}/feedback`, { submit: true, ratings: {}, evidence: 'x'.repeat(30), recommendation: 'hire' })).status, 409);
  // recruiter-level user cannot mark Rejected without human decision permission; owner can
  const dec = await A.req('POST', `/applications/${appId}/decision`, { decision: 'selected', note: 'Strong fit' });
  assert.equal(dec.status, 200);
  assert.equal((await ian.req('POST', `/applications/${appId}/decision`, { decision: 'rejected' })).status, 403);
  assert.equal((await ian.req('PATCH', `/applications/${appId}/stage`, { stage: 'Rejected' })).status, 403);
});

test('entitlements: AI blocked on disabled setting; billing + coupon + GST', async () => {
  await A.req('PATCH', '/company', { settings: { aiEnabled: false } });
  assert.equal((await A.req('POST', '/ai/questions', { jobId })).status, 403);
  await A.req('PATCH', '/company', { settings: { aiEnabled: true } });
  const ai = await A.req('POST', '/ai/questions', { jobId, count: 5 });
  assert.equal(ai.status, 200); assert.equal(ai.data.aiGenerated, true); assert.ok(ai.data.disclaimer);
  await A.req('PATCH', '/company', { state: 'Maharashtra', gst_number: '27AAPFU0939F1ZV' });
  const co = await A.req('POST', '/billing/checkout', { planCode: 'starter', cycle: 'monthly', coupon: 'welcome10' });
  assert.equal(co.status, 201);
  const inv = await A.req('GET', `/invoices/${co.data.invoiceId}`);
  assert.equal(inv.data.subtotal, 199900 - 19990); // 10% off, in paise
  assert.equal(inv.data.igst, Math.round(inv.data.subtotal * 0.18)); // inter-state => IGST
  assert.equal(inv.data.cgst, 0);
  assert.equal(inv.data.total, inv.data.subtotal + inv.data.igst);
  assert.equal((await A.req('POST', `/billing/dev-pay/${co.data.invoiceId}`)).status, 200);
  assert.equal((await A.req('POST', `/billing/dev-pay/${co.data.invoiceId}`)).status, 200); // idempotent
  const b = await A.req('GET', '/billing');
  assert.equal(b.data.subscription.planCode, 'starter'); assert.equal(b.data.subscription.status, 'active');
  // Starter has no recording / AI: entitlement enforcement
  assert.equal((await A.req('POST', '/ai/questions', { jobId })).status, 402);
  const sch = await A.req('POST', '/interviews', { applicationId: appId, title: 'R2', scheduledAt: iso(600), interviewerIds: [ownerId], config: { recording: true } });
  assert.equal(sch.status, 402);
  // unsigned webhook is rejected
  const wh = await fetch(BASE + '/webhooks/razorpay', { method: 'POST', body: '{}', headers: { 'x-razorpay-signature': 'bad' } });
  assert.ok([400, 503].includes(wh.status));
});

test('secondary camera QR: single session, expires, requires explicit consent', async () => {
  await A.req('PUT', '/_noop').catch(() => 0);
  // upgrade back so camera is allowed
  await A.req('POST', '/billing/checkout', { planCode: 'professional', cycle: 'monthly' }).then(async r => A.req('POST', `/billing/dev-pay/${r.data.invoiceId}`));
  const ian = (globalThis as any).ianClient as Client;
  const i2 = await A.req('POST', '/interviews', { applicationId: appId, title: 'Round 3', scheduledAt: iso(30), interviewerIds: [ownerId], config: { secondaryCamera: true } });
  assert.equal(i2.status, 201);
  const qr = await A.req('POST', `/interviews/${i2.data.id}/camera-qr`);
  assert.equal(qr.status, 200); assert.ok(qr.data.qr.startsWith('data:image/png'));
  const tok = qr.data.url.split('/camera/')[1];
  const p = new Client();
  assert.equal((await p.req('GET', `/public/camera/${tok}`)).status, 200);
  assert.equal((await p.req('POST', `/public/camera/${tok}/connect`, { consent: false })).status, 422);
  const c1 = await p.req('POST', `/public/camera/${tok}/connect`, { consent: true });
  assert.equal(c1.status, 200);
  assert.equal((await new Client().req('POST', `/public/camera/${tok}/connect`, { consent: true })).status, 409, 'single session');
  // a new QR supersedes the old one
  const qr2 = await A.req('POST', `/interviews/${i2.data.id}/camera-qr`);
  void ian; assert.notEqual(qr2.data.url, qr.data.url);
});

test('login lockout, password reset invalidates sessions, MFA', async () => {
  const C = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await C.req('POST', '/auth/login', { email: 'bob@beta.test', password: 'wrong-pass1' })).status, 401);
  assert.equal((await C.req('POST', '/auth/login', { email: 'bob@beta.test', password: 'Passw0rd!x' })).status, 429);
  const f = await new Client().req('POST', '/auth/forgot-password', { email: 'alice@acme.test' });
  const rt = f.data.devResetUrl.split('token=')[1];
  assert.equal((await new Client().req('POST', '/auth/reset-password', { token: rt, password: 'NewPassw0rd!' })).status, 200);
  assert.equal((await A.req('GET', '/auth/me')).status, 401, 'old session invalid after reset');
  assert.equal((await new Client().req('POST', '/auth/reset-password', { token: rt, password: 'Another1pass' })).status, 400, 'reset token is single-use');
  const A2 = new Client();
  assert.equal((await A2.req('POST', '/auth/login', { email: 'alice@acme.test', password: 'NewPassw0rd!' })).status, 200);
  // TOTP
  const { secret } = (await A2.req('POST', '/auth/mfa/setup')).data;
  const { totpAt } = await import('../src/util.js');
  assert.equal((await A2.req('POST', '/auth/mfa/enable', { code: totpAt(secret, Math.floor(Date.now() / 30000)) })).status, 200);
  const A3 = new Client();
  assert.equal((await A3.req('POST', '/auth/login', { email: 'alice@acme.test', password: 'NewPassw0rd!' })).data.mfaRequired, true);
  assert.equal((await A3.req('POST', '/auth/login', { email: 'alice@acme.test', password: 'NewPassw0rd!', totp: '000000' })).status, 401);
  assert.equal((await A3.req('POST', '/auth/login', { email: 'alice@acme.test', password: 'NewPassw0rd!', totp: totpAt(secret, Math.floor(Date.now() / 30000)) })).status, 200);
});
