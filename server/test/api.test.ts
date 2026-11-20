import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import * as Y from 'yjs';

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
  // Regression: fields the old SQL schema defaulted must be present on new documents (MongoDB has no column defaults).
  const det = await A.req('GET', `/interviews/${interviewId}`);
  assert.equal(det.data.status, 'scheduled'); assert.equal(det.data.type, 'technical'); assert.equal(det.data.round_no, 1); assert.equal(det.data.timezone, 'UTC');
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
  await until(() => S.msgs.some(m => m.t === 'code-yjs'));
  C.ws.send(JSON.stringify({ t: 'code-run', file: 'main.js', stdin: '' }));
  await until(() => S.msgs.some(m => m.t === 'code-result'), 10000);
  const res = S.msgs.find(m => m.t === 'code-result').result;
  assert.equal(res.stdout.trim(), '42');
  // concurrent editing converges (Yjs CRDT): both sides type at the same time
  const dS = new Y.Doc(), dC = new Y.Doc();
  const hookDoc = (d: Y.Doc, me: any) => { d.on('update', (u: Uint8Array, o: any) => { if (o !== 'remote') me.ws.send(JSON.stringify({ t: 'code-yjs', file: 'main.js', update: Buffer.from(u).toString('base64') })); }); };
  const feed = (d: Y.Doc, me: any) => { let n = 0; return () => { const ms = me.msgs.filter((m: any) => m.t === 'code-yjs'); for (; n < ms.length; n++) Y.applyUpdate(d, new Uint8Array(Buffer.from(ms[n].update, 'base64')), 'remote'); }; };
  S.ws.send(JSON.stringify({ t: 'code-yjs-sync', file: 'main.js' })); C.ws.send(JSON.stringify({ t: 'code-yjs-sync', file: 'main.js' }));
  await until(() => S.msgs.some((m: any) => m.t === 'code-yjs' && m.sync) && C.msgs.some((m: any) => m.t === 'code-yjs' && m.sync));
  const fs_ = feed(dS, S), fc_ = feed(dC, C); fs_(); fc_();
  assert.equal(dS.getText('c').toString(), dC.getText('c').toString());
  hookDoc(dS, S); hookDoc(dC, C);
  const before = dS.getText('c').toString();
  dS.getText('c').insert(0, '/*S*/'); dC.getText('c').insert(dC.getText('c').length, '/*C*/');
  const settled = () => { fs_(); fc_(); const a = dS.getText('c').toString(); return a === dC.getText('c').toString() && a.includes('/*S*/') && a.includes('/*C*/'); };
  await until(settled);
  assert.equal(dS.getText('c').toString(), '/*S*/' + before + '/*C*/');
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

test('company admin creates an HR account; HR activates via single-use link; HR permissions enforced', async () => {
  // admin creates the account directly (no password chosen or sent by the admin)
  const bad = await A.req('POST', '/team/members', { name: 'H', email: 'not-an-email', role: 'hr' });
  assert.equal(bad.status, 422);
  const r = await A.req('POST', '/team/members', { name: 'Hema HR', email: 'Hema@Acme.test', role: 'hr', designation: 'HR Business Partner' });
  assert.equal(r.status, 201); assert.equal(r.data.newAccount, true); assert.ok(r.data.devActivateUrl);
  const dup = await A.req('POST', '/team/members', { name: 'Hema HR', email: 'hema@acme.test', role: 'hr' });
  assert.equal(dup.status, 409);
  const team = await A.req('GET', '/team');
  const hm = team.data.members.find((m: any) => m.email === 'hema@acme.test');
  assert.equal(hm.role, 'hr'); assert.equal(hm.pending_activation, true); assert.equal(hm.designation, 'HR Business Partner');
  // cannot sign in before activation
  const H = new Client();
  assert.equal((await H.req('POST', '/auth/login', { email: 'hema@acme.test', password: 'anything1' })).status, 401);
  // resending invalidates the first link
  const first = new URL(r.data.devActivateUrl).searchParams.get('token')!;
  const resend = await A.req('POST', `/team/members/${hm.id}/resend-activation`);
  assert.equal(resend.status, 200);
  assert.equal((await H.req('POST', '/auth/activate', { token: first, password: 'HemaPassw0rd' })).status, 400, 'old link no longer works');
  const token = new URL(resend.data.devActivateUrl).searchParams.get('token')!;
  const info = await H.req('GET', `/auth/activate/${token}`);
  assert.equal(info.data.company, 'Acme Corp'); assert.equal(info.data.role, 'hr');
  assert.equal((await H.req('POST', '/auth/activate', { token, password: 'short' })).status, 422, 'password policy applies');
  const act = await H.req('POST', '/auth/activate', { token, password: 'HemaPassw0rd' });
  assert.equal(act.status, 200); assert.equal(act.data.role, 'hr'); assert.equal(act.data.user.emailVerified, true);
  assert.equal((await H.req('POST', '/auth/activate', { token, password: 'HemaPassw0rd' })).status, 400, 'single use');
  assert.equal((await A.req('GET', '/team')).data.members.find((m: any) => m.email === 'hema@acme.test').pending_activation, false);
  // HR can do HR work...
  assert.equal((await H.req('POST', '/jobs', { title: 'HR-created role', required_skills: ['communication'] })).status, 201);
  assert.equal((await H.req('GET', '/analytics')).status, 200);
  // ...but cannot manage the team, billing or company settings
  assert.equal((await H.req('POST', '/team/members', { name: 'Sneaky Admin', email: 'sneaky@acme.test', role: 'admin' })).status, 403);
  assert.equal((await H.req('PATCH', '/company', { name: 'Hacked' })).status, 403);
  assert.equal((await H.req('GET', '/billing')).status, 403);
  // an existing IntervueX user added by another company keeps their account (no new password, no activation)
  const x = await B.req('POST', '/team/members', { name: 'Hema HR', email: 'hema@acme.test', role: 'recruiter' });
  assert.equal(x.status, 201); assert.equal(x.data.newAccount, false); assert.equal(x.data.devActivateUrl, undefined);
  const again = new Client();
  const li = await again.req('POST', '/auth/login', { email: 'hema@acme.test', password: 'HemaPassw0rd' });
  assert.equal(li.status, 200); assert.equal(li.data.memberships.length, 2);
});

test('candidate portal: job board, verified-only access, apply, track, shared updates, invited interviews', async () => {
  // company publishes a job (listed on the board) and a hidden one
  const job = await A.req('POST', '/jobs', { title: 'Portal React Engineer', location: 'Pune', employment_type: 'Full-time', required_skills: ['react', 'typescript'], preferred_skills: ['node'], screening_questions: ['Notice period?'] });
  assert.equal(job.status, 201);
  assert.equal((await A.req('POST', `/jobs/${job.data.id}/status`, { status: 'published' })).status, 200);
  const hidden = await A.req('POST', '/jobs', { title: 'Confidential Role', required_skills: ['react'], public_listing: false });
  await A.req('POST', `/jobs/${hidden.data.id}/status`, { status: 'published' });

  // anonymous job search
  const P = new Client();
  const search = await P.req('GET', '/portal/jobs?q=react');
  assert.equal(search.status, 200);
  assert.ok(search.data.items.some((x: any) => x.id === job.data.id));
  assert.ok(!search.data.items.some((x: any) => x.id === hidden.data.id), 'opted-out jobs are not listed');
  assert.equal((await P.req('GET', `/portal/jobs/${hidden.data.id}`)).status, 404);
  assert.equal((await P.req('GET', '/portal/applications')).status, 401, 'portal data needs a candidate session');

  // candidate signs up; staff session cookies and candidate cookies are separate
  const reg = await P.req('POST', '/portal/auth/register', { name: 'Ravi Kumar', email: 'Ravi@Mail.test', password: 'RaviPassw0rd' });
  assert.equal(reg.status, 201); assert.equal(reg.data.emailVerified, false);
  assert.equal((await P.req('GET', '/jobs')).status, 401, 'a candidate session cannot use staff APIs');
  assert.equal((await A.req('GET', '/portal/me')).status, 401, 'a staff session is not a candidate session');

  // unverified: cannot apply, and sees no company data
  await P.req('PATCH', '/portal/profile', { skills: ['react', 'typescript', 'css'], headline: 'Frontend Engineer', experience_years: 4 });
  assert.equal((await P.req('POST', `/portal/jobs/${job.data.id}/apply`, { answers: [{ question: 'Notice period?', answer: '30 days' }] })).status, 403);
  const tok = new URL(reg.data.devVerifyUrl).searchParams.get('token');
  assert.equal((await P.req('POST', '/portal/auth/verify', { token: tok })).status, 200);

  // recommendations use profile skills
  const rec = await P.req('GET', '/portal/recommendations');
  assert.ok(rec.data.items.some((x: any) => x.id === job.data.id && x.matchedSkills.includes('react')));

  // screening answers are required; then apply once
  assert.equal((await P.req('POST', `/portal/jobs/${job.data.id}/apply`, { answers: [] })).status, 400);
  const ap = await P.req('POST', `/portal/jobs/${job.data.id}/apply`, { cover_note: 'Keen to join', answers: [{ question: 'Notice period?', answer: '30 days' }] });
  assert.equal(ap.status, 201);
  assert.equal((await P.req('POST', `/portal/jobs/${job.data.id}/apply`, { answers: [{ question: 'Notice period?', answer: '30 days' }] })).status, 409);

  // the company sees the applicant
  const cl = await A.req('GET', '/candidates?q=ravi');
  const cand = cl.data.items.find((c: any) => c.email.toLowerCase() === 'ravi@mail.test');
  assert.ok(cand); assert.equal(cand.source, 'portal');

  // staff share an update; internal scores/notes are not exposed to the candidate
  assert.equal((await A.req('POST', `/applications/${ap.data.applicationId}/updates`, { message: 'Thanks Ravi, we are reviewing your profile.' })).status, 201);
  const apps = await P.req('GET', '/portal/applications');
  const mine = apps.data.items.find((x: any) => x.id === ap.data.applicationId);
  assert.equal(mine.status.label, 'Application received');
  assert.equal(mine.updates[0].message, 'Thanks Ravi, we are reviewing your profile.');
  assert.equal(mine.match_score, undefined); assert.equal(JSON.stringify(mine).includes('match_detail'), false);

  // the company invites the candidate to an interview -> it appears in the portal; joining is gated by the join window
  const team = await A.req('GET', '/team');
  const lead = team.data.members.find((m: any) => m.role === 'owner').user_id;
  const iv = await A.req('POST', '/interviews', { applicationId: ap.data.applicationId, title: 'Portal Round', scheduledAt: iso(240), durationMin: 30, interviewerIds: [lead], config: {} });
  assert.equal(iv.status, 201);
  const ivs = await P.req('GET', '/portal/interviews');
  assert.ok(ivs.data.upcoming.some((x: any) => x.id === iv.data.id));
  assert.equal((await P.req('POST', `/portal/interviews/${iv.data.id}/ticket`)).status, 425, 'room not open yet');
  // another candidate cannot see or join it
  const Q = new Client();
  const r2 = await Q.req('POST', '/portal/auth/register', { name: 'Other Person', email: 'other@mail.test', password: 'OtherPassw0rd' });
  await Q.req('POST', '/portal/auth/verify', { token: new URL(r2.data.devVerifyUrl).searchParams.get('token') });
  assert.equal((await Q.req('GET', '/portal/interviews')).data.upcoming.length, 0);
  assert.equal((await Q.req('POST', `/portal/interviews/${iv.data.id}/ticket`)).status, 404);

  // saved jobs and withdrawal
  assert.equal((await P.req('POST', `/portal/jobs/${job.data.id}/save`)).status, 200);
  assert.equal((await P.req('GET', '/portal/saved')).data.items.length, 1);
  assert.equal((await P.req('POST', `/portal/applications/${ap.data.applicationId}/withdraw`)).status, 200);
  assert.equal((await P.req('GET', '/portal/applications')).data.items.find((x: any) => x.id === ap.data.applicationId).status.key, 'withdrawn');
});

test('employee referral portal: HR-created accounts, employee isolation, referral, bonus lifecycle', async () => {
  // HR (not an admin) can create employee accounts, but no other roles
  const H2 = new Client();
  assert.equal((await H2.req('POST', '/auth/login', { email: 'hema@acme.test', password: 'HemaPassw0rd' })).status, 200);
  assert.equal((await H2.req('POST', '/team/members', { name: 'Nope Recruiter', email: 'nope@acme.test', role: 'recruiter' })).status, 403);
  const emp = await H2.req('POST', '/team/members', { name: 'Esha Employee', email: 'esha@acme.test', role: 'employee', designation: 'Support Engineer' });
  assert.equal(emp.status, 201); assert.ok(emp.data.devActivateUrl);
  const E = new Client();
  const act = await E.req('POST', '/auth/activate', { token: new URL(emp.data.devActivateUrl).searchParams.get('token'), password: 'EshaPassw0rd' });
  assert.equal(act.status, 200); assert.equal(act.data.role, 'employee');

  // default-deny: an employee cannot reach hiring data, questions, team or settings
  for (const u of ['/jobs', '/candidates', '/interviews', '/questions', '/team', '/company', '/analytics', '/usage', '/evaluation-template', '/referrals'])
    assert.equal((await E.req('GET', u)).status, 403, `employee must not read ${u}`);

  // programme + a referral-enabled job with its own bonus
  assert.equal((await A.req('PUT', '/referrals/program', { enabled: true, defaultBonus: 20000, payoutAfterDays: 0, terms: 'Paid after joining.' })).status, 200);
  const job = await A.req('POST', '/jobs', { title: 'Referral QA Engineer', required_skills: ['testing'], referral_bonus: 35000 });
  await A.req('POST', `/jobs/${job.data.id}/status`, { status: 'published' });
  const open = await E.req('GET', '/referrals/jobs');
  assert.equal(open.status, 200);
  const listed = open.data.items.find((x: any) => x.id === job.data.id);
  assert.equal(listed.bonus, 35000);
  assert.equal(JSON.stringify(open.data).includes('applicants'), false);

  // refer (with consent), no self-referral, no duplicates
  const base = { job_id: job.data.id, relationship: 'former_colleague', consent: true };
  assert.equal((await E.req('POST', '/referrals', { ...base, name: 'Esha Employee', email: 'esha@acme.test' })).status, 400);
  assert.equal((await E.req('POST', '/referrals', { ...base, name: 'Kiran Rao', email: 'kiran@mail.test', consent: false })).status, 422);
  const ref = await E.req('POST', '/referrals', { ...base, name: 'Kiran Rao', email: 'Kiran@Mail.test', note: 'Great tester' });
  assert.equal(ref.status, 201);
  assert.equal((await E.req('POST', '/referrals', { ...base, name: 'Kiran Rao', email: 'kiran@mail.test' })).status, 409);

  // employee sees a friendly status for their own referral only
  let mine = await E.req('GET', '/referrals/mine');
  assert.equal(mine.data.items.length, 1);
  assert.equal(mine.data.items[0].status.label, 'Referral received');
  assert.equal(mine.data.items[0].bonus.status, 'pending'); assert.equal(mine.data.items[0].bonus.amount, 35000);
  assert.equal(JSON.stringify(mine.data).includes('match'), false);

  // HR sees it with the referrer; the candidate enters the normal pipeline as a referral
  const all = await H2.req('GET', '/referrals');
  const row = all.data.items.find((x: any) => x.id === ref.data.id);
  assert.equal(row.referrer_name, 'Esha Employee');
  const cand = (await A.req('GET', '/candidates?q=kiran')).data.items.find((c: any) => c.email.toLowerCase() === 'kiran@mail.test');
  assert.equal(cand.source, 'referral');

  // bonus cannot be paid before the hire; after "Selected" (waiting period 0) it becomes payable, then paid
  assert.equal((await H2.req('PATCH', `/referrals/${ref.data.id}/bonus`, { action: 'mark_paid' })).status, 400);
  const appId = (await A.req('GET', `/candidates/${cand.id}`)).data.applications.find((a: any) => a.job_id === job.data.id).id;
  assert.equal((await A.req('PATCH', `/applications/${appId}/stage`, { stage: 'Selected' })).status, 200);
  mine = await E.req('GET', '/referrals/mine');
  assert.equal(mine.data.items[0].status.key, 'hired'); assert.equal(mine.data.items[0].bonus.status, 'eligible');
  assert.equal((await E.req('PATCH', `/referrals/${ref.data.id}/bonus`, { action: 'mark_paid' })).status, 403, 'employees cannot pay themselves');
  assert.equal((await H2.req('PATCH', `/referrals/${ref.data.id}/bonus`, { action: 'mark_paid', note: 'Nov payroll' })).status, 200);
  mine = await E.req('GET', '/referrals/mine');
  assert.equal(mine.data.items[0].bonus.status, 'paid'); assert.equal(mine.data.summary.paid, 35000);

  // HR can disable the employee; the session then stops working
  const team = await A.req('GET', '/team');
  const em = team.data.members.find((m: any) => m.email === 'esha@acme.test');
  assert.equal((await H2.req('PATCH', `/team/members/${em.id}`, { status: 'disabled' })).status, 200);
  assert.equal((await E.req('GET', '/referrals/mine')).status, 403);
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
