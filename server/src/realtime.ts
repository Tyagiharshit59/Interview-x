import * as Y from 'yjs';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { db, uid, now, j } from './db.js';
import { config } from './config.js';
import { audit, enforce, recordUsage, logActivity, notify, scanFile } from './services.js';
import { runCode, runTests, logExecution, LANGUAGES } from './code.js';

type Kind = 'staff' | 'candidate' | 'camera';
export interface Ticket { interviewId: string; companyId: string; kind: Kind; userId?: string; name: string; role: string; cameraSessionId?: string }
const tickets = new Map<string, Ticket & { exp: number }>();

/** One-time, 2-minute realtime ticket. Never a reusable public session token. */
export function createRoomTicket(t: Ticket) {
  const id = crypto.randomBytes(24).toString('base64url');
  tickets.set(id, { ...t, exp: Date.now() + 120_000 });
  return id;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of tickets) if (v.exp < n) tickets.delete(k); }, 30_000).unref();

interface Peer {
  id: string; ws: WebSocket; kind: Kind; name: string; role: string; userId?: string; admitted: boolean; joinedAt: number;
  media: { audio: boolean; video: boolean; screen: boolean; screenStreamId?: string }; alive: boolean; cameraSessionId?: string;
}
interface Room {
  id: string; companyId: string; peers: Map<string, Peer>; files: Record<string, { content: string; language: string; version: number }>; activeFile: string;
  codeEditAllowed: boolean; screenAllowed: Set<string>; whiteboard: any[]; recording: { active: boolean; paused: boolean; sources: string[] };
  consents: { recording: boolean | null; secondaryCamera: boolean | null }; paused: boolean; dirtyFiles: Set<string>; wbDirty: boolean; lastSnap: number;
  questionId: string | null;
}
const rooms = new Map<string, Room>();

/* ---- collaborative text (Yjs CRDT): one Y.Doc per file; server keeps it so late joiners sync and runs/snapshots see the merged text ---- */
const docs = new WeakMap<Room, Map<string, Y.Doc>>();
function ydocFor(r: Room, name: string): Y.Doc {
  let m = docs.get(r); if (!m) { m = new Map(); docs.set(r, m); }
  let d = m.get(name); if (d) return d;
  d = new Y.Doc(); const t = d.getText('c');
  const f = r.files[name]; const seed = (f?.content ?? '').replace(/\r\n?/g, '\n');
  if (seed) t.insert(0, seed);
  t.observe(() => { const ff = r.files[name]; if (!ff) return; ff.content = t.toString(); ff.version++; r.dirtyFiles.add(name); });
  m.set(name, d); return d;
}
/** Replaces the whole text with a minimal diff. Returns the Yjs update to broadcast. */
function setYText(r: Room, name: string, content: string): Uint8Array {
  const d = ydocFor(r, name); const t = d.getText('c'); const a = t.toString(); const b = content.replace(/\r\n?/g, '\n');
  let st = 0; while (st < a.length && st < b.length && a[st] === b[st]) st++;
  let ea = a.length, eb = b.length; while (ea > st && eb > st && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  let upd: Uint8Array = new Uint8Array(); const h = (u: Uint8Array) => { upd = u; }; d.on('update', h);
  d.transact(() => { if (ea > st) t.delete(st, ea - st); if (eb > st) t.insert(st, b.slice(st, eb)); });
  d.off('update', h); return upd;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

const loading = new Map<string, Promise<Room>>();
async function loadRoom(interviewId: string, companyId: string): Promise<Room> {
  const existing = rooms.get(interviewId); if (existing) return existing;
  let pending = loading.get(interviewId);
  if (!pending) { pending = buildRoom(interviewId, companyId).finally(() => loading.delete(interviewId)); loading.set(interviewId, pending); }
  return pending;
}
async function buildRoom(interviewId: string, companyId: string): Promise<Room> {
  let r: Room;
  const i = await db.interviews.get({ id: interviewId, company_id: companyId });
  const cfg = j(i?.config, {} as any);
  const files: Room['files'] = {};
  const snaps = await db.code_snapshots.list({ interview_id: interviewId, company_id: companyId }, { sort: { created_at: 1, _seq: 1 } });
  for (const s of snaps) files[s.file_name] = { content: s.content, language: s.language || 'javascript', version: 0 };
  let questionId: string | null = cfg.codingQuestionId || null;
  if (!Object.keys(files).length) {
    const lang = cfg.language || 'javascript';
    let starter = '// Write your solution here\n';
    if (questionId) {
      const q = await db.coding_questions.get({ id: questionId, company_id: companyId });
      starter = j(q?.starter_code, {} as any)[lang] || starter;
    }
    files['main.' + (LANGUAGES[lang]?.ext || 'txt')] = { content: starter, language: lang, version: 0 };
  }
  const wb = await db.whiteboard_sessions.get({ interview_id: interviewId, company_id: companyId });
  const cons = async (k: string) => { const c = await db.consent_records.get({ interview_id: interviewId, kind: k, company_id: companyId }, { sort: { created_at: -1, _seq: -1 } }); return c ? !!c.granted : null; };
  const consRecording = await cons('recording'), consSecondary = await cons('secondary_camera');
  r = {
    id: interviewId, companyId, peers: new Map(), files, activeFile: Object.keys(files)[0], codeEditAllowed: true, screenAllowed: new Set(), whiteboard: j(wb?.data, []),
    recording: { active: false, paused: false, sources: [] }, consents: { recording: consRecording, secondaryCamera: consSecondary }, paused: false,
    dirtyFiles: new Set(), wbDirty: false, lastSnap: 0, questionId,
  };
  rooms.set(interviewId, r);
  return r;
}

const send = (p: Peer, msg: any) => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg)); };
const staff = (r: Room) => [...r.peers.values()].filter(p => p.kind === 'staff');
const admitted = (r: Room) => [...r.peers.values()].filter(p => p.admitted);
const broadcast = (r: Room, msg: any, except?: string, filter?: (p: Peer) => boolean) => { for (const p of admitted(r)) if (p.id !== except && (!filter || filter(p))) send(p, msg); };
const pub = (p: Peer) => ({ id: p.id, kind: p.kind, name: p.name, role: p.role, media: p.media });
const offsetSec = async (interviewId: string) => {
  const i = await db.interviews.get({ id: interviewId });
  return i?.started_at ? Math.max(0, (Date.now() - new Date(i.started_at).getTime()) / 1000) : 0;
};
const addEvent = async (r: Room, kind: string, label: string | null, author?: string) => {
  const off = await offsetSec(r.id);
  await db.recording_events.insert({ company_id: r.companyId, interview_id: r.id, kind, label, offset_sec: off, author_id: author ?? null, created_at: now() });
  broadcast(r, { t: 'timeline', event: { kind, label, offset_sec: off } }, undefined, p => p.kind === 'staff');
};

async function persistCode(r: Room, force = false) {
  const t = Date.now();
  if (!force && t - r.lastSnap < 15_000) return;
  r.lastSnap = t;
  // Take the work synchronously so concurrent calls never write the same snapshot twice.
  const files = [...r.dirtyFiles].map(f => [f, r.files[f]] as const).filter(([, file]) => !!file).map(([f, file]) => ({ f, language: file!.language, content: file!.content }));
  r.dirtyFiles.clear();
  const wb = r.wbDirty ? JSON.stringify(r.whiteboard) : null; r.wbDirty = false;
  try {
    for (const x of files) await db.code_snapshots.insert({ company_id: r.companyId, interview_id: r.id, file_name: x.f, language: x.language, content: x.content, author: 'collab', created_at: now() });
    if (wb !== null) await db.whiteboard_sessions.upsert({ interview_id: r.id }, { data: wb, updated_at: now() }, { company_id: r.companyId });
  } catch (e) { console.error('[realtime] persist failed', e); for (const x of files) r.dirtyFiles.add(x.f); if (wb !== null) r.wbDirty = true; }
}
setInterval(() => { for (const r of rooms.values()) void persistCode(r); }, 15_000).unref();

async function stateFor(r: Room, me: Peer) {
  const iv = await db.interviews.get({ id: r.id, company_id: r.companyId });
  const cfg = j(iv.config, {} as any);
  const q = r.questionId ? await db.coding_questions.get({ id: r.questionId, company_id: r.companyId }) : null;
  const chat = (await db.chat_messages.list({ interview_id: r.id, company_id: r.companyId }, { sort: { created_at: -1, _seq: -1 }, limit: 100 }))
    .reverse().map(c => ({ name: c.sender_name, role: c.sender_role, text: c.body, at: c.created_at }));
  return {
    status: iv.status, startedAt: iv.started_at, durationMin: iv.duration_min, config: { coding: !!cfg.coding, whiteboard: cfg.whiteboard !== false, recording: !!cfg.recording, secondaryCamera: !!cfg.secondaryCamera },
    files: r.files, activeFile: r.activeFile, codeEditAllowed: r.codeEditAllowed, whiteboard: r.whiteboard, recording: r.recording, consents: r.consents, paused: r.paused,
    question: q ? { id: q.id, title: q.title, prompt: q.prompt } : null, chat, screenAllowed: [...r.screenAllowed], runner: { mode: config.runner.mode },
    canShareScreen: me.kind === 'staff' || r.screenAllowed.has(me.id) || !!cfg.allowCandidateScreenShare,
  };
}

async function admit(r: Room, p: Peer) {
  p.admitted = true;
  const state = await stateFor(r, p);
  const others = admitted(r).filter(x => x.id !== p.id && visible(p, x));
  send(p, { t: 'welcome', you: pub(p), peers: others.map(pub), state });
  broadcast(r, { t: 'peer-joined', peer: pub(p) }, p.id, x => visible(x, p));
  if (p.kind === 'candidate') await addEvent(r, 'candidate_joined', p.name);
  pushWaiting(r);
}
/** Visibility: a secondary camera only sees staff, and is only seen by staff. */
const visible = (a: Peer, b: Peer) => !(a.kind === 'camera' && b.kind !== 'staff') && !(b.kind === 'camera' && a.kind !== 'staff');
const pushWaiting = (r: Room) => {
  const waiting = [...r.peers.values()].filter(p => !p.admitted).map(p => ({ id: p.id, name: p.name, kind: p.kind }));
  for (const s of staff(r)) if (s.admitted) send(s, { t: 'waiting', waiting });
};

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const origin = req.headers.origin;
    if (config.isProd && origin && origin !== config.appUrl) return socket.destroy();
    const tk = tickets.get(url.searchParams.get('ticket') || '');
    if (!tk || tk.exp < Date.now()) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    tickets.delete(url.searchParams.get('ticket')!); // single use
    wss.handleUpgrade(req, socket, head, ws => { onConnect(ws, tk).catch(e => { console.error('[realtime] connect failed', e); try { ws.close(1011, 'Server error'); } catch { /* closed */ } }); });
  });

  setInterval(() => {
    for (const r of rooms.values()) for (const p of r.peers.values()) {
      if (!p.alive) { p.ws.terminate(); continue; }
      p.alive = false; try { p.ws.ping(); } catch { /* closed */ }
    }
  }, 20_000).unref();
}

async function onConnect(ws: WebSocket, tk: Ticket) {
  // Buffer messages that arrive while the room loads, then process each peer's messages strictly in order.
  const early: any[] = []; const onEarly = (raw: any) => early.push(raw); ws.on('message', onEarly);
  const iv = await db.interviews.get({ id: tk.interviewId, company_id: tk.companyId });
  if (!iv || iv.status === 'cancelled') { ws.close(4403, 'Interview unavailable'); return; }
  const r = await loadRoom(tk.interviewId, tk.companyId);
  ws.off('message', onEarly);
  if (r.peers.size >= 10) { ws.close(4429, 'Room is full'); return; }
  // Replace a stale connection of the same person (reconnect)
  for (const old of r.peers.values()) {
    if ((tk.userId && old.userId === tk.userId && old.kind === tk.kind) || (tk.kind === 'candidate' && old.kind === 'candidate')) {
      send(old, { t: 'replaced' }); old.ws.close(4000, 'Replaced'); r.peers.delete(old.id); broadcast(r, { t: 'peer-left', id: old.id }, old.id);
    }
  }
  const peer: Peer = {
    id: uid().slice(0, 8), ws, kind: tk.kind, name: tk.name, role: tk.role, userId: tk.userId, admitted: tk.kind === 'staff' || tk.kind === 'camera',
    joinedAt: Date.now(), media: { audio: false, video: false, screen: false }, alive: true, cameraSessionId: tk.cameraSessionId,
  };
  r.peers.set(peer.id, peer);
  ws.on('pong', () => { peer.alive = true; });
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (raw: any) => {
    peer.alive = true;
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    queue = queue.then(() => handle(r, peer, m)).catch((e: any) => send(peer, { t: 'error', message: e?.message || 'Something went wrong', code: e?.code }));
  };
  if (peer.admitted) queue = queue.then(() => admit(r, peer)).catch(e => console.error('[realtime] admit failed', e));
  else { send(peer, { t: 'waiting-room', you: { id: peer.id, name: peer.name } }); pushWaiting(r); }
  for (const raw of early) enqueue(raw);
  ws.on('message', enqueue);
  ws.on('close', () => { void (async () => {
    if (r.peers.get(peer.id)?.ws !== ws) return;
    r.peers.delete(peer.id);
    r.screenAllowed.delete(peer.id);
    broadcast(r, { t: 'peer-left', id: peer.id }, peer.id);
    pushWaiting(r);
    const empty = !r.peers.size;
    if (empty) rooms.delete(r.id); // a reconnect from now on builds a fresh room from the saved snapshots
    if (peer.kind === 'camera' && peer.cameraSessionId) await db.camera_sessions.set({ id: peer.cameraSessionId, company_id: r.companyId }, { ended_at: now() });
    if (peer.kind === 'camera') await addEvent(r, 'secondary_camera_disconnected', null);
    if (peer.kind === 'candidate') await addEvent(r, 'candidate_left', peer.name);
    if (empty) { await persistCode(r, true); docs.get(r)?.forEach(d => d.destroy()); docs.delete(r); }
  })().catch(e => console.error('[realtime] close handling failed', e)); });
}

const isStaff = (p: Peer) => p.kind === 'staff';
const need = (c: boolean, msg = 'Not allowed') => { if (!c) throw Object.assign(new Error(msg), { code: 'forbidden' }); };

async function handle(r: Room, p: Peer, m: any): Promise<void> {
  if (!p.admitted && !['ping'].includes(m.t)) return;
  switch (m.t) {
    case 'ping': return send(p, { t: 'pong' });

    case 'admit': {
      need(isStaff(p)); const t = r.peers.get(m.peerId); if (t && !t.admitted) await admit(r, t); return;
    }
    case 'deny': {
      need(isStaff(p)); const t = r.peers.get(m.peerId); if (t && !t.admitted) { send(t, { t: 'denied' }); t.ws.close(4403, 'Denied'); } return;
    }
    case 'kick': {
      need(isStaff(p)); const t = r.peers.get(m.peerId); if (t && t.id !== p.id && t.kind !== 'staff') { send(t, { t: 'kicked' }); t.ws.close(4403, 'Removed'); } return;
    }
    case 'signal': {
      const t = r.peers.get(m.to);
      if (!t || !t.admitted || !visible(p, t)) return;
      return send(t, { t: 'signal', from: p.id, data: m.data });
    }
    case 'media': {
      p.media = { audio: !!m.audio, video: !!m.video, screen: !!m.screen, screenStreamId: m.screen ? String(m.screenStreamId || '') : undefined };
      if (m.screen) await addEvent(r, 'screen_share_started', p.name); else if (m.screenStopped) await addEvent(r, 'screen_share_stopped', p.name);
      return broadcast(r, { t: 'media', id: p.id, media: p.media }, p.id, x => visible(x, p));
    }
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 2000); if (!text) return;
      need(p.kind !== 'camera');
      await db.chat_messages.insert({ company_id: r.companyId, interview_id: r.id, sender_name: p.name, sender_role: p.kind, body: text, created_at: now() });
      return broadcast(r, { t: 'chat', name: p.name, role: p.kind, text, at: now() }, undefined, x => x.kind !== 'camera');
    }
    case 'chat-file': {
      need(p.kind !== 'camera');
      const name = String(m.name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 80);
      const buf = Buffer.from(String(m.data || ''), 'base64');
      if (!buf.length || buf.length > 2 * 1024 * 1024) throw new Error('Files must be under 2 MB');
      const ext = (name.split('.').pop() || '').toLowerCase();
      const sig = buf.slice(0, 8).toString('hex');
      const ok = (ext === 'png' && sig.startsWith('89504e47')) || ((ext === 'jpg' || ext === 'jpeg') && sig.startsWith('ffd8ff')) || (ext === 'pdf' && buf.slice(0, 4).toString() === '%PDF')
        || (ext === 'txt' && !buf.includes(0));
      if (!ok) throw new Error('Only PNG, JPG, PDF and TXT files are allowed');
      if (buf.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))) throw new Error('File rejected by malware scan');
      const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain' } as any)[ext];
      return broadcast(r, { t: 'chat-file', name: p.name, role: p.kind, file: { name, mime, data: buf.toString('base64') }, at: now() }, undefined, x => x.kind !== 'camera');
    }

    /* ---- interview lifecycle (staff) ---- */
    case 'interview-start': {
      need(isStaff(p));
      const iv = await db.interviews.get({ id: r.id, company_id: r.companyId });
      if (iv.status === 'completed') throw new Error('Interview already ended');
      if (iv.status !== 'in_progress') {
        await db.interviews.set({ id: r.id, company_id: r.companyId }, { status: 'in_progress', started_at: now() });
        await addEvent(r, 'interview_started', null, p.userId);
        broadcast(r, { t: 'status', status: 'in_progress', startedAt: now() });
      }
      return;
    }
    case 'interview-end': {
      need(isStaff(p));
      const iv = await db.interviews.get({ id: r.id, company_id: r.companyId });
      if (iv.status === 'completed') return;
      await addEvent(r, 'interview_ended', null, p.userId);
      const end = now();
      await db.interviews.set({ id: r.id, company_id: r.companyId }, { status: 'completed', ended_at: end });
      const mins = iv.started_at ? (new Date(end).getTime() - new Date(iv.started_at).getTime()) / 60000 : 0;
      if (mins > 0) await recordUsage(r.companyId, 'interview_minutes', Math.round(mins * 10) / 10, r.id);
      await db.applications.set({ id: iv.application_id, company_id: r.companyId, stage: { $in: ['Interview Scheduled', 'Shortlisted', 'Screening', 'Applied'] } }, { stage: 'Interview Completed', updated_at: now() });
      await logActivity(r.companyId, { applicationId: iv.application_id, actorId: p.userId, action: 'interview.completed', detail: iv.title });
      for (const pp of await db.interview_participants.list({ interview_id: r.id }))
        await notify(r.companyId, pp.user_id, 'evaluation', `Submit your feedback: ${iv.title}`, 'The interview has ended. Your evaluation is pending.', `/interviews/${r.id}/feedback`, { email: true });
      await persistCode(r, true);
      broadcast(r, { t: 'status', status: 'completed' });
      return;
    }
    case 'pause': { need(isStaff(p)); r.paused = !!m.paused; await addEvent(r, r.paused ? 'break_started' : 'break_ended', null, p.userId); return broadcast(r, { t: 'paused', paused: r.paused }); }
    case 'marker': {
      need(isStaff(p));
      const allowed = ['introductions', 'technical_questions', 'coding_started', 'system_design', 'break', 'wrap_up', 'custom'];
      const kind = allowed.includes(m.kind) ? m.kind : 'custom';
      return addEvent(r, kind, m.label ? String(m.label).slice(0, 200) : null, p.userId);
    }

    /* ---- consent & recording ---- */
    case 'consent': {
      need(p.kind === 'candidate' || p.kind === 'camera', 'Only the candidate can give consent');
      const kind = m.kind === 'secondary_camera' ? 'secondary_camera' : m.kind === 'secondary_recording' ? 'secondary_recording' : 'recording';
      const granted = !!m.granted;
      await db.consent_records.insert({ company_id: r.companyId, interview_id: r.id, subject: p.name, kind, granted: +granted, notice_version: 'v1', ip: null, created_at: now() });
      if (kind === 'recording') r.consents.recording = granted;
      if (kind === 'secondary_camera') r.consents.secondaryCamera = granted;
      if (kind === 'recording' && !granted && r.recording.active) { r.recording = { active: false, paused: false, sources: [] }; broadcast(r, { t: 'recording', recording: r.recording, reason: 'Candidate withdrew consent' }); }
      return broadcast(r, { t: 'consents', consents: r.consents, extra: { kind, granted } });
    }
    case 'rec-state': {
      need(isStaff(p));
      const cfg = j((await db.interviews.get({ id: r.id, company_id: r.companyId }))?.config, {} as any);
      need(!!cfg.recording, 'Recording is not enabled for this interview');
      if (m.active) {
        need(r.consents.recording === true, 'The candidate has not consented to recording');
        await enforce(r.companyId, { feature: 'recording' });
      }
      r.recording = { active: !!m.active, paused: !!m.paused, sources: Array.isArray(m.sources) ? m.sources.map(String).slice(0, 4) : [] };
      await addEvent(r, m.active ? (m.paused ? 'recording_paused' : 'recording_started') : 'recording_stopped', null, p.userId);
      return broadcast(r, { t: 'recording', recording: r.recording });
    }

    /* ---- screen share permissions ---- */
    case 'screen-request': {
      need(p.kind === 'candidate');
      return broadcast(r, { t: 'screen-request', id: p.id, name: p.name }, undefined, isStaff);
    }
    case 'screen-permission': {
      need(isStaff(p));
      if (m.allow) r.screenAllowed.add(m.peerId); else r.screenAllowed.delete(m.peerId);
      const t = r.peers.get(m.peerId); if (t) send(t, { t: 'screen-permission', allow: !!m.allow });
      return;
    }

    /* ---- collaborative code ---- */
    case 'code-update': {
      need(p.kind !== 'camera');
      need(isStaff(p) || r.codeEditAllowed, 'Editing is currently disabled by the interviewer');
      const name = String(m.file || r.activeFile).slice(0, 60);
      const content = String(m.content ?? '').slice(0, 200_000);
      const f = r.files[name] ?? (r.files[name] = { content: '', language: m.language || 'javascript', version: 0 });
      if (m.language && LANGUAGES[m.language]) f.language = m.language;
      const upd = setYText(r, name, content);
      return broadcast(r, { t: 'code-yjs', file: name, update: b64(upd), language: f.language }, p.id, x => x.kind !== 'camera');
    }
    case 'code-yjs': { // incremental CRDT update from an editor
      need(p.kind !== 'camera');
      need(isStaff(p) || r.codeEditAllowed, 'Editing is currently disabled by the interviewer');
      const name = String(m.file || r.activeFile).slice(0, 60); need(!!r.files[name], 'Unknown file');
      const buf = Buffer.from(String(m.update || ''), 'base64'); need(buf.length > 0 && buf.length <= 400_000, 'Bad update');
      const d = ydocFor(r, name);
      try { Y.applyUpdate(d, new Uint8Array(buf), p.id); } catch { throw Object.assign(new Error('Bad update'), { code: 'bad_update' }); }
      broadcast(r, { t: 'code-yjs', file: name, update: m.update }, p.id, x => x.kind !== 'camera');
      const t = d.getText('c');
      if (t.length > 200_000) { // Yjs cannot roll back: trim the tail and tell everyone
        let trim: Uint8Array = new Uint8Array(); const h = (u: Uint8Array) => { trim = u; }; d.on('update', h);
        d.transact(() => t.delete(200_000, t.length - 200_000)); d.off('update', h);
        broadcast(r, { t: 'code-yjs', file: name, update: b64(trim) }, undefined, x => x.kind !== 'camera');
        send(p, { t: 'error', message: 'File is too large (200,000 characters max); the excess was removed.' });
      }
      return;
    }
    case 'code-yjs-sync': { // client asks for the full current state of a file
      need(p.kind !== 'camera');
      const name = String(m.file || r.activeFile).slice(0, 60); need(!!r.files[name], 'Unknown file');
      return send(p, { t: 'code-yjs', file: name, update: b64(Y.encodeStateAsUpdate(ydocFor(r, name))), sync: true, language: r.files[name].language });
    }
    case 'code-language': {
      need(p.kind !== 'camera'); need(isStaff(p) || r.codeEditAllowed);
      const name = String(m.file || r.activeFile).slice(0, 60); const f = r.files[name]; need(!!f, 'Unknown file');
      if (m.language && LANGUAGES[m.language]) { f.language = m.language; r.dirtyFiles.add(name); }
      return broadcast(r, { t: 'code-language', file: name, language: f.language }, undefined, x => x.kind !== 'camera');
    }
    case 'code-file-add': {
      need(isStaff(p) || r.codeEditAllowed);
      const name = String(m.file || '').replace(/[^\w.\-]/g, '').slice(0, 40); if (!name || r.files[name] || Object.keys(r.files).length >= 12) return;
      const ext = name.split('.').pop() || '';
      const lang = Object.entries(LANGUAGES).find(([, v]) => v.ext === ext)?.[0] || 'javascript';
      r.files[name] = { content: '', language: lang, version: 0 }; r.dirtyFiles.add(name);
      return broadcast(r, { t: 'code-files', files: r.files }, undefined, x => x.kind !== 'camera');
    }
    case 'code-permission': { need(isStaff(p)); r.codeEditAllowed = !!m.allow; return broadcast(r, { t: 'code-permission', allow: r.codeEditAllowed }); }
    case 'code-question': {
      need(isStaff(p));
      const q = await db.coding_questions.get({ id: String(m.questionId || ''), company_id: r.companyId });
      need(!!q, 'Question not found');
      r.questionId = q.id;
      const lang = String(m.language || 'javascript');
      const starter = j(q.starter_code, {} as any)[lang];
      let starterUpdate: string | null = null;
      if (starter && m.applyStarter) { const fn = r.activeFile; if (!r.files[fn]) r.files[fn] = { content: '', language: lang, version: 0 }; r.files[fn].language = lang; starterUpdate = b64(setYText(r, fn, starter)); r.dirtyFiles.add(fn); }
      await addEvent(r, 'coding_started', q.title, p.userId);
      broadcast(r, { t: 'code-question', question: { id: q.id, title: q.title, prompt: q.prompt }, files: r.files }, undefined, x => x.kind !== 'camera');
      if (starterUpdate) broadcast(r, { t: 'code-yjs', file: r.activeFile, update: starterUpdate }, undefined, x => x.kind !== 'camera');
      return;
    }
    case 'code-run': {
      need(p.kind !== 'camera');
      const file = r.files[String(m.file || r.activeFile)]; need(!!file, 'File not found');
      const lang = file.language;
      void (async () => {
        try {
          await enforce(r.companyId, { feature: 'coding', metric: 'code_runs', limitKey: 'code_runs_per_month' });
          broadcast(r, { t: 'code-running', by: p.name }, undefined, x => x.kind !== 'camera');
          const res = await runCode(lang, file.content, String(m.stdin || '').slice(0, 10000), 5);
          await recordUsage(r.companyId, 'code_runs', 1, r.id); await logExecution(r.companyId, r.id, lang, res);
          await db.coding_submissions.insert({ company_id: r.companyId, interview_id: r.id, question_id: null, user_id: p.userId ?? null, language: lang, code: file.content, kind: 'run', created_at: now() });
          broadcast(r, { t: 'code-result', kind: 'run', by: p.name, result: res }, undefined, x => x.kind !== 'camera');
        } catch (e: any) { send(p, { t: 'error', message: e.message, code: e.code }); broadcast(r, { t: 'code-result', kind: 'run', by: p.name, result: { status: 'Error', ok: false, stdout: '', stderr: e.message, compileOutput: '', timeMs: null, memoryKb: null } }, undefined, x => x.kind !== 'camera'); }
      })();
      return;
    }
    case 'code-submit': {
      need(p.kind !== 'camera');
      const qid = r.questionId; need(!!qid, 'No question is assigned');
      const file = r.files[String(m.file || r.activeFile)]; need(!!file, 'File not found');
      void (async () => {
        try {
          const cases = await db.coding_test_cases.count({ question_id: qid, company_id: r.companyId });
          await enforce(r.companyId, { feature: 'coding', metric: 'code_runs', limitKey: 'code_runs_per_month', add: Math.max(1, cases) });
          broadcast(r, { t: 'code-running', by: p.name }, undefined, x => x.kind !== 'camera');
          const out = await runTests(r.companyId, qid!, file.language, file.content, { revealHidden: false });
          await recordUsage(r.companyId, 'code_runs', Math.max(1, cases), r.id);
          const subId = await db.coding_submissions.insert({ company_id: r.companyId, interview_id: r.id, question_id: qid, user_id: p.userId ?? null, language: file.language, code: file.content, kind: 'submit', passed: out.passed, total: out.total, score: out.score, results: JSON.stringify(out.outcomes), created_at: now() });
          // Candidates see public tests in detail; hidden only pass/fail. Staff see everything.
          const full = out.outcomes;
          const redacted = full.map(o => o.hidden ? { id: o.id, hidden: true, passed: o.passed, status: o.status, timeMs: o.timeMs } : o);
          for (const x of admitted(r)) if (x.kind !== 'camera') send(x, { t: 'code-result', kind: 'submit', by: p.name, result: { passed: out.passed, total: out.total, score: out.score, outcomes: isStaff(x) ? full : redacted }, submissionId: subId });
          await addEvent(r, 'code_submitted', `${out.passed}/${out.total} tests`, p.userId);
        } catch (e: any) { send(p, { t: 'error', message: e.message, code: e.code }); }
      })();
      return;
    }
    case 'review-signal': {
      // Tab/window events are REVIEW SIGNALS only, never proof of misconduct.
      need(p.kind === 'candidate');
      const type = ['tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'paste', 'fullscreen_exit'].includes(m.type) ? m.type : null; if (!type) return;
      return addEvent(r, 'signal:' + type, null);
    }

    /* ---- whiteboard ---- */
    case 'wb': {
      need(p.kind !== 'camera');
      if (m.op === 'stroke' && m.item) { if (r.whiteboard.length < 5000) r.whiteboard.push({ ...m.item, by: p.id }); }
      else if (m.op === 'undo') { const idx = r.whiteboard.map((s: any) => s.by).lastIndexOf(p.id); if (idx >= 0) { const [rm] = r.whiteboard.splice(idx, 1); m.removedId = rm.id; } }
      else if (m.op === 'clear') { need(isStaff(p)); r.whiteboard = []; }
      else return;
      r.wbDirty = true;
      return broadcast(r, { t: 'wb', op: m.op, item: m.item ? { ...m.item, by: p.id } : undefined, removedId: m.removedId }, p.id, x => x.kind !== 'camera');
    }
    default: return;
  }
}

export { audit, scanFile };
