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

function loadRoom(interviewId: string, companyId: string): Room {
  let r = rooms.get(interviewId);
  if (r) return r;
  const i = db.prepare('SELECT config FROM interviews WHERE id=?').get(interviewId) as any;
  const cfg = j(i?.config, {} as any);
  const files: Room['files'] = {};
  const snaps = db.prepare('SELECT file_name, language, content FROM code_snapshots WHERE interview_id=? AND company_id=? ORDER BY created_at').all(interviewId, companyId) as any[];
  for (const s of snaps) files[s.file_name] = { content: s.content, language: s.language || 'javascript', version: 0 };
  let questionId: string | null = cfg.codingQuestionId || null;
  if (!Object.keys(files).length) {
    const lang = cfg.language || 'javascript';
    let starter = '// Write your solution here\n';
    if (questionId) {
      const q = db.prepare('SELECT starter_code FROM coding_questions WHERE id=? AND company_id=?').get(questionId, companyId) as any;
      starter = j(q?.starter_code, {} as any)[lang] || starter;
    }
    files['main.' + (LANGUAGES[lang]?.ext || 'txt')] = { content: starter, language: lang, version: 0 };
  }
  const wb = db.prepare('SELECT data FROM whiteboard_sessions WHERE interview_id=? AND company_id=?').get(interviewId, companyId) as any;
  const cons = (k: string) => { const c = db.prepare('SELECT granted FROM consent_records WHERE interview_id=? AND kind=? AND company_id=? ORDER BY created_at DESC LIMIT 1').get(interviewId, k, companyId) as any; return c ? !!c.granted : null; };
  r = {
    id: interviewId, companyId, peers: new Map(), files, activeFile: Object.keys(files)[0], codeEditAllowed: true, screenAllowed: new Set(), whiteboard: j(wb?.data, []),
    recording: { active: false, paused: false, sources: [] }, consents: { recording: cons('recording'), secondaryCamera: cons('secondary_camera') }, paused: false,
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
const offsetSec = (interviewId: string) => {
  const i = db.prepare('SELECT started_at FROM interviews WHERE id=?').get(interviewId) as any;
  return i?.started_at ? Math.max(0, (Date.now() - new Date(i.started_at).getTime()) / 1000) : 0;
};
const addEvent = (r: Room, kind: string, label: string | null, author?: string) => {
  const off = offsetSec(r.id);
  db.prepare('INSERT INTO recording_events(id,company_id,interview_id,kind,label,offset_sec,author_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid(), r.companyId, r.id, kind, label, off, author ?? null, now());
  broadcast(r, { t: 'timeline', event: { kind, label, offset_sec: off } }, undefined, p => p.kind === 'staff');
};

function persistCode(r: Room, force = false) {
  const t = Date.now();
  if (!force && t - r.lastSnap < 15_000) return;
  r.lastSnap = t;
  for (const f of r.dirtyFiles) {
    const file = r.files[f]; if (!file) continue;
    db.prepare('INSERT INTO code_snapshots(id,company_id,interview_id,file_name,language,content,author,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid(), r.companyId, r.id, f, file.language, file.content, 'collab', now());
  }
  r.dirtyFiles.clear();
  if (r.wbDirty) {
    db.prepare(`INSERT INTO whiteboard_sessions(id,company_id,interview_id,data,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(interview_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`).run(uid(), r.companyId, r.id, JSON.stringify(r.whiteboard), now());
    r.wbDirty = false;
  }
}
setInterval(() => { for (const r of rooms.values()) persistCode(r); }, 15_000).unref();

function stateFor(r: Room, me: Peer) {
  const iv = db.prepare('SELECT status, started_at, config, duration_min FROM interviews WHERE id=?').get(r.id) as any;
  const cfg = j(iv.config, {} as any);
  const q = r.questionId ? db.prepare('SELECT id,title,prompt,starter_code,languages FROM coding_questions WHERE id=? AND company_id=?').get(r.questionId, r.companyId) as any : null;
  const chat = db.prepare('SELECT sender_name name, sender_role role, body text, created_at at FROM chat_messages WHERE interview_id=? AND company_id=? ORDER BY created_at DESC LIMIT 100').all(r.id, r.companyId).reverse();
  return {
    status: iv.status, startedAt: iv.started_at, durationMin: iv.duration_min, config: { coding: !!cfg.coding, whiteboard: cfg.whiteboard !== false, recording: !!cfg.recording, secondaryCamera: !!cfg.secondaryCamera },
    files: r.files, activeFile: r.activeFile, codeEditAllowed: r.codeEditAllowed, whiteboard: r.whiteboard, recording: r.recording, consents: r.consents, paused: r.paused,
    question: q ? { id: q.id, title: q.title, prompt: q.prompt } : null, chat, screenAllowed: [...r.screenAllowed], runner: { mode: config.runner.mode },
    canShareScreen: me.kind === 'staff' || r.screenAllowed.has(me.id) || !!cfg.allowCandidateScreenShare,
  };
}

function admit(r: Room, p: Peer) {
  p.admitted = true;
  const others = admitted(r).filter(x => x.id !== p.id && visible(p, x));
  send(p, { t: 'welcome', you: pub(p), peers: others.map(pub), state: stateFor(r, p) });
  broadcast(r, { t: 'peer-joined', peer: pub(p) }, p.id, x => visible(x, p));
  if (p.kind === 'candidate') addEvent(r, 'candidate_joined', p.name);
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
    wss.handleUpgrade(req, socket, head, ws => onConnect(ws, tk));
  });

  setInterval(() => {
    for (const r of rooms.values()) for (const p of r.peers.values()) {
      if (!p.alive) { p.ws.terminate(); continue; }
      p.alive = false; try { p.ws.ping(); } catch { /* closed */ }
    }
  }, 20_000).unref();
}

function onConnect(ws: WebSocket, tk: Ticket) {
  const iv = db.prepare('SELECT status FROM interviews WHERE id=? AND company_id=?').get(tk.interviewId, tk.companyId) as any;
  if (!iv || iv.status === 'cancelled') { ws.close(4403, 'Interview unavailable'); return; }
  const r = loadRoom(tk.interviewId, tk.companyId);
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
  if (peer.admitted) admit(r, peer);
  else { send(peer, { t: 'waiting-room', you: { id: peer.id, name: peer.name } }); pushWaiting(r); }

  ws.on('message', raw => {
    peer.alive = true;
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    try { handle(r, peer, m); } catch (e: any) { send(peer, { t: 'error', message: e?.message || 'Something went wrong', code: e?.code }); }
  });
  ws.on('close', () => {
    if (r.peers.get(peer.id)?.ws !== ws) return;
    r.peers.delete(peer.id);
    r.screenAllowed.delete(peer.id);
    broadcast(r, { t: 'peer-left', id: peer.id }, peer.id);
    pushWaiting(r);
    if (peer.kind === 'camera' && peer.cameraSessionId) db.prepare('UPDATE camera_sessions SET ended_at=? WHERE id=?').run(now(), peer.cameraSessionId);
    if (peer.kind === 'camera') addEvent(r, 'secondary_camera_disconnected', null);
    if (peer.kind === 'candidate') addEvent(r, 'candidate_left', peer.name);
    if (!r.peers.size) { persistCode(r, true); docs.get(r)?.forEach(d => d.destroy()); docs.delete(r); rooms.delete(r.id); }
  });
}

const isStaff = (p: Peer) => p.kind === 'staff';
const need = (c: boolean, msg = 'Not allowed') => { if (!c) throw Object.assign(new Error(msg), { code: 'forbidden' }); };

function handle(r: Room, p: Peer, m: any) {
  if (!p.admitted && !['ping'].includes(m.t)) return;
  switch (m.t) {
    case 'ping': return send(p, { t: 'pong' });

    case 'admit': {
      need(isStaff(p)); const t = r.peers.get(m.peerId); if (t && !t.admitted) admit(r, t); return;
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
      if (m.screen) addEvent(r, 'screen_share_started', p.name); else if (m.screenStopped) addEvent(r, 'screen_share_stopped', p.name);
      return broadcast(r, { t: 'media', id: p.id, media: p.media }, p.id, x => visible(x, p));
    }
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 2000); if (!text) return;
      need(p.kind !== 'camera');
      db.prepare('INSERT INTO chat_messages(id,company_id,interview_id,sender_name,sender_role,body,created_at) VALUES (?,?,?,?,?,?,?)').run(uid(), r.companyId, r.id, p.name, p.kind, text, now());
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
      const iv = db.prepare('SELECT status FROM interviews WHERE id=?').get(r.id) as any;
      if (iv.status === 'completed') throw new Error('Interview already ended');
      if (iv.status !== 'in_progress') {
        db.prepare("UPDATE interviews SET status='in_progress', started_at=? WHERE id=?").run(now(), r.id);
        addEvent(r, 'interview_started', null, p.userId);
        broadcast(r, { t: 'status', status: 'in_progress', startedAt: now() });
      }
      return;
    }
    case 'interview-end': {
      need(isStaff(p));
      const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(r.id) as any;
      if (iv.status === 'completed') return;
      addEvent(r, 'interview_ended', null, p.userId);
      const end = now();
      db.prepare("UPDATE interviews SET status='completed', ended_at=? WHERE id=?").run(end, r.id);
      const mins = iv.started_at ? (new Date(end).getTime() - new Date(iv.started_at).getTime()) / 60000 : 0;
      if (mins > 0) recordUsage(r.companyId, 'interview_minutes', Math.round(mins * 10) / 10, r.id);
      db.prepare("UPDATE applications SET stage='Interview Completed', updated_at=? WHERE id=? AND stage IN ('Interview Scheduled','Shortlisted','Screening','Applied')").run(now(), iv.application_id);
      logActivity(r.companyId, { applicationId: iv.application_id, actorId: p.userId, action: 'interview.completed', detail: iv.title });
      for (const pp of db.prepare('SELECT user_id FROM interview_participants WHERE interview_id=?').all(r.id) as any[])
        notify(r.companyId, pp.user_id, 'evaluation', `Submit your feedback: ${iv.title}`, 'The interview has ended. Your evaluation is pending.', `/interviews/${r.id}/feedback`, { email: true });
      persistCode(r, true);
      broadcast(r, { t: 'status', status: 'completed' });
      return;
    }
    case 'pause': { need(isStaff(p)); r.paused = !!m.paused; addEvent(r, r.paused ? 'break_started' : 'break_ended', null, p.userId); return broadcast(r, { t: 'paused', paused: r.paused }); }
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
      db.prepare('INSERT INTO consent_records(id,company_id,interview_id,subject,kind,granted,notice_version,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid(), r.companyId, r.id, p.name, kind, +granted, 'v1', now());
      if (kind === 'recording') r.consents.recording = granted;
      if (kind === 'secondary_camera') r.consents.secondaryCamera = granted;
      if (kind === 'recording' && !granted && r.recording.active) { r.recording = { active: false, paused: false, sources: [] }; broadcast(r, { t: 'recording', recording: r.recording, reason: 'Candidate withdrew consent' }); }
      return broadcast(r, { t: 'consents', consents: r.consents, extra: { kind, granted } });
    }
    case 'rec-state': {
      need(isStaff(p));
      const cfg = j((db.prepare('SELECT config FROM interviews WHERE id=?').get(r.id) as any).config, {} as any);
      need(!!cfg.recording, 'Recording is not enabled for this interview');
      if (m.active) {
        need(r.consents.recording === true, 'The candidate has not consented to recording');
        enforce(r.companyId, { feature: 'recording' });
      }
      r.recording = { active: !!m.active, paused: !!m.paused, sources: Array.isArray(m.sources) ? m.sources.map(String).slice(0, 4) : [] };
      addEvent(r, m.active ? (m.paused ? 'recording_paused' : 'recording_started') : 'recording_stopped', null, p.userId);
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
      const q = db.prepare('SELECT id,title,prompt,starter_code FROM coding_questions WHERE id=? AND company_id=?').get(m.questionId, r.companyId) as any;
      need(!!q, 'Question not found');
      r.questionId = q.id;
      const lang = String(m.language || 'javascript');
      const starter = j(q.starter_code, {} as any)[lang];
      let starterUpdate: string | null = null;
      if (starter && m.applyStarter) { const fn = r.activeFile; if (!r.files[fn]) r.files[fn] = { content: '', language: lang, version: 0 }; r.files[fn].language = lang; starterUpdate = b64(setYText(r, fn, starter)); r.dirtyFiles.add(fn); }
      addEvent(r, 'coding_started', q.title, p.userId);
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
          enforce(r.companyId, { feature: 'coding', metric: 'code_runs', limitKey: 'code_runs_per_month' });
          broadcast(r, { t: 'code-running', by: p.name }, undefined, x => x.kind !== 'camera');
          const res = await runCode(lang, file.content, String(m.stdin || '').slice(0, 10000), 5);
          recordUsage(r.companyId, 'code_runs', 1, r.id); logExecution(r.companyId, r.id, lang, res);
          db.prepare('INSERT INTO coding_submissions(id,company_id,interview_id,question_id,user_id,language,code,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid(), r.companyId, r.id, null, p.userId ?? null, lang, file.content, 'run', now());
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
          const cases = (db.prepare('SELECT COUNT(*) c FROM coding_test_cases WHERE question_id=? AND company_id=?').get(qid, r.companyId) as any).c;
          enforce(r.companyId, { feature: 'coding', metric: 'code_runs', limitKey: 'code_runs_per_month', add: Math.max(1, cases) });
          broadcast(r, { t: 'code-running', by: p.name }, undefined, x => x.kind !== 'camera');
          const out = await runTests(r.companyId, qid!, file.language, file.content, { revealHidden: false });
          recordUsage(r.companyId, 'code_runs', Math.max(1, cases), r.id);
          const subId = uid();
          db.prepare('INSERT INTO coding_submissions(id,company_id,interview_id,question_id,user_id,language,code,kind,passed,total,score,results,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(subId, r.companyId, r.id, qid, p.userId ?? null, file.language, file.content, 'submit', out.passed, out.total, out.score, JSON.stringify(out.outcomes), now());
          // Candidates see public tests in detail; hidden only pass/fail. Staff see everything.
          const full = out.outcomes;
          const redacted = full.map(o => o.hidden ? { id: o.id, hidden: true, passed: o.passed, status: o.status, timeMs: o.timeMs } : o);
          for (const x of admitted(r)) if (x.kind !== 'camera') send(x, { t: 'code-result', kind: 'submit', by: p.name, result: { passed: out.passed, total: out.total, score: out.score, outcomes: isStaff(x) ? full : redacted }, submissionId: subId });
          addEvent(r, 'code_submitted', `${out.passed}/${out.total} tests`, p.userId);
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
