import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, put } from '../api';
import { ChatPanel, CodePanel, QualityBars, VideoTile, Whiteboard, applyWb, type CodeFiles } from './parts';
import { getUserMedia, useRoom, type Ticket } from './useRoom';

interface Props {
  kind: 'staff' | 'candidate';
  getTicket: () => Promise<Ticket>;
  title: string; displayName: string; interviewId?: string; preStream?: MediaStream | null; notice?: { recording: string; secondaryCamera: string };
  onExit: () => void;
}
const mmss = (s: number) => { const a = Math.abs(Math.floor(s)); return `${s < 0 ? '-' : ''}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`; };
const pickMime = () => ['video/webm;codecs=vp8,opus', 'video/webm'].find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) || 'video/webm';

/** Streams MediaRecorder chunks to the server. Sequential uploads with retries so ordering is preserved. */
class ChunkRecorder {
  id = ''; mr: MediaRecorder | null = null; queue: Blob[] = []; busy = false; failed = false; done: (() => void) | null = null; stopping = false;
  constructor(private interviewId: string, private source: string, private stream: MediaStream, private onError: (m: string) => void) {}
  async start() {
    const mime = pickMime();
    const r = await post(`/interviews/${this.interviewId}/recordings`, { source: this.source, mime: mime.split(';')[0] });
    this.id = r.id;
    this.mr = new MediaRecorder(this.stream, { mimeType: mime });
    this.mr.ondataavailable = e => { if (e.data.size) { this.queue.push(e.data); void this.pump(); } };
    this.mr.onstop = () => { this.stopping = true; void this.pump(); };
    this.mr.start(4000);
  }
  async pump() {
    if (this.busy) return; this.busy = true;
    while (this.queue.length) {
      const b = this.queue[0]; let ok = false;
      for (let i = 0; i < 4 && !ok; i++) {
        try { const r = await fetch(`/api/recordings/${this.id}/chunk`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: b, credentials: 'same-origin' }); ok = r.ok; } catch { /* retry */ }
        if (!ok) await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
      if (!ok) { this.failed = true; this.onError('Recording upload is failing. Check your connection.'); this.queue = []; break; }
      this.queue.shift();
    }
    this.busy = false;
    if (this.stopping && !this.queue.length) { try { await post(`/recordings/${this.id}/complete`); } catch { /* */ } this.done?.(); }
  }
  pause() { this.mr?.state === 'recording' && this.mr.pause(); } resume() { this.mr?.state === 'paused' && this.mr.resume(); }
  stop() { return new Promise<void>(res => { this.done = res; if (this.mr && this.mr.state !== 'inactive') this.mr.stop(); else res(); }); }
}

export function RoomView({ kind, getTicket, title, displayName, interviewId, preStream, notice, onExit }: Props) {
  const isStaff = kind === 'staff';
  /* ---- state driven by realtime messages ---- */
  const [chat, setChat] = useState<any[]>([]); const [files, setFiles] = useState<CodeFiles>({}); const [active, setActive] = useState(''); const [allowEdit, setAllowEdit] = useState(true);
  const [wb, setWb] = useState<any[]>([]); const [status, setStatus] = useState('scheduled'); const [startedAt, setStartedAt] = useState<string | null>(null); const [duration, setDuration] = useState(60);
  const [rec, setRec] = useState({ active: false, paused: false, sources: [] as string[] }); const [consents, setConsents] = useState<{ recording: boolean | null; secondaryCamera: boolean | null }>({ recording: null, secondaryCamera: null });
  const [secRec, setSecRec] = useState<boolean>(false); const [paused, setPaused] = useState(false); const [question, setQuestion] = useState<any>(null); const [result, setResult] = useState<any>(null); const [running, setRunning] = useState(false);
  const [cfg, setCfg] = useState({ coding: false, whiteboard: true, recording: false, secondaryCamera: false }); const [canShare, setCanShare] = useState(false); const [shareReqs, setShareReqs] = useState<Array<{ id: string; name: string }>>([]);
  const [notices, setNotices] = useState<string[]>([]); const [timeline, setTimeline] = useState<any[]>([]); const [unread, setUnread] = useState(0);
  const [tab, setTab] = useState<'video' | 'code' | 'board'>('video'); const [side, setSide] = useState<'chat' | 'people' | 'notes' | 'session'>('chat');
  const [micOn, setMicOn] = useState(true); const [camOn, setCamOn] = useState(true); const [sharing, setSharing] = useState(false); const [mediaErr, setMediaErr] = useState(''); const [now, setNow] = useState(Date.now());
  const [reqSent, setReqSent] = useState(false); const [showConsent, setShowConsent] = useState(false); const [ended, setEnded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null); const stream = useRef<MediaStream | null>(preStream ?? null); const [localStream, setLocalStreamState] = useState<MediaStream | null>(preStream ?? null);
  const recorders = useRef<ChunkRecorder[]>([]); const sideRef = useRef(side); sideRef.current = side; const meIdRef = useRef('');
  const flash = (m: string) => { setNotices(n => [...n, m]); setTimeout(() => setNotices(n => n.slice(1)), 6000); };

  const yHandlers = useRef(new Set<(m: any) => void>()); const [yEpoch, setYEpoch] = useState(0);
  const room = useRoom({
    kind, getTicket, onMessage: m => {
      switch (m.t) {
        case 'welcome': {
          const s = m.state; setChat(s.chat || []); setFiles(s.files); setActive(s.activeFile); setYEpoch(e => e + 1); setAllowEdit(s.codeEditAllowed); setWb(s.whiteboard || []); setStatus(s.status); setStartedAt(s.startedAt); setDuration(s.durationMin);
          setRec(s.recording); setConsents(s.consents); setPaused(s.paused); setQuestion(s.question); setCfg(s.config); setCanShare(s.canShareScreen);
          if (!isStaff && s.config.recording && s.consents.recording === null) setShowConsent(true);
          break;
        }
        case 'chat': setChat(c => [...c, m]); if (sideRef.current !== 'chat') setUnread(u => u + 1); break;
        case 'chat-file': setChat(c => [...c, { name: m.name, at: m.at, file: m.file }]); if (sideRef.current !== 'chat') setUnread(u => u + 1); break;
        case 'code-yjs': yHandlers.current.forEach(h => h(m)); if (m.language) setFiles(f => f[m.file] ? { ...f, [m.file]: { ...f[m.file], language: m.language } } : f); break;
        case 'code-language': setFiles(f => f[m.file] ? { ...f, [m.file]: { ...f[m.file], language: m.language } } : f); break;
        case 'code-update': setFiles(f => ({ ...f, [m.file]: { content: m.content, language: m.language, version: m.version } })); break;
        case 'code-files': setFiles(m.files); break;
        case 'code-permission': setAllowEdit(m.allow); break;
        case 'code-question': setQuestion(m.question); setFiles(m.files); if (cfg.coding || true) setTab('code'); break;
        case 'code-running': setRunning(true); break;
        case 'code-result': setRunning(false); setResult(m); break;
        case 'wb': setWb(p => applyWb(p, m)); break;
        case 'status': setStatus(m.status); if (m.startedAt) setStartedAt(m.startedAt); if (m.status === 'completed') setEnded(true); break;
        case 'paused': setPaused(m.paused); break;
        case 'recording': setRec(m.recording); if (m.reason) flash(m.reason); break;
        case 'consents': setConsents(m.consents); if (m.extra?.kind === 'secondary_recording') setSecRec(!!m.extra.granted); if (isStaff && m.extra) flash(`Candidate ${m.extra.granted ? 'granted' : 'declined'} consent for ${String(m.extra.kind).replace('_', ' ')}`); break;
        case 'screen-request': setShareReqs(r => [...r.filter(x => x.id !== m.id), { id: m.id, name: m.name }]); setSide('people'); flash(`${m.name} asks to share their screen`); break;
        case 'screen-permission': setCanShare(m.allow); if (!m.allow) stopShare(); else flash('You may now share your screen'); break;
        case 'timeline': setTimeline(t => [...t, m.event]); break;
        case 'error': setRunning(false); flash(m.message); break;
        case 'peer-joined': if (m.peer.kind === 'camera' && isStaff) flash('Secondary camera connected (waiting for candidate consent)'); if (isStaff && m.peer.kind === 'candidate') flash(`${m.peer.name} joined`); break;
        case 'peer-left': break;
        default: break;
      }
    },
  });
  meIdRef.current = room.me?.id || '';

  /* ---- local media ---- */
  const acquire = useCallback(async () => {
    setMediaErr('');
    try { const s = await getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }); stream.current = s; }
    catch (e: any) {
      try { const s = await getUserMedia({ audio: true, video: false }); stream.current = s; setCamOn(false); setMediaErr(`${e.message} Joining with audio only.`); }
      catch (e2: any) { stream.current = null; setMicOn(false); setCamOn(false); setMediaErr(`${e2.message} You can still join and chat; ask the interviewer for help.`); }
    }
    setLocalStreamState(stream.current); room.setLocalStream(stream.current);
    // eslint-disable-next-line
  }, []);
  useEffect(() => {
    (async () => { if (!stream.current) await acquire(); else room.setLocalStream(stream.current); await room.connect(); })();
    // eslint-disable-next-line
  }, []);
  useEffect(() => { if (localStream) room.setLocalStream(localStream); /* eslint-disable-next-line */ }, [room.phase === 'joined']);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const mediaMsg = (over: any = {}) => room.send({ t: 'media', audio: micOn, video: camOn, screen: sharing, ...over });
  useEffect(() => { if (room.phase === 'joined') mediaMsg(); /* eslint-disable-next-line */ }, [room.phase]);

  const toggleMic = () => { const on = !micOn; stream.current?.getAudioTracks().forEach(t => (t.enabled = on)); setMicOn(on); mediaMsg({ audio: on }); };
  const toggleCam = () => { const on = !camOn; stream.current?.getVideoTracks().forEach(t => (t.enabled = on)); setCamOn(on); mediaMsg({ video: on }); };
  const startShare = async () => {
    if (!canShare && !isStaff) { room.send({ t: 'screen-request' }); setReqSent(true); flash('Request sent. The interviewer will allow or decline.'); return; }
    try { const s = await room.startScreen(); setSharing(true); mediaMsg({ screen: true, screenStreamId: s.id }); setTab('video'); } catch (e: any) { if (e.name !== 'NotAllowedError') flash('Screen sharing is not available in this browser.'); }
  };
  const stopShare = () => { room.stopScreen(); };
  useEffect(() => { const h = () => { setSharing(false); room.send({ t: 'media', audio: micOn, video: camOn, screen: false, screenStopped: true }); }; window.addEventListener('ivx:screen-stopped', h); return () => window.removeEventListener('ivx:screen-stopped', h); });
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void rootRef.current?.requestFullscreen?.(); };

  /* candidate review signals: tab / window / fullscreen events are signals for human review, not proof of anything */
  useEffect(() => {
    if (isStaff) return;
    const vis = () => room.send({ t: 'review-signal', type: document.hidden ? 'tab_hidden' : 'tab_visible' });
    const blur = () => room.send({ t: 'review-signal', type: 'window_blur' }); const foc = () => room.send({ t: 'review-signal', type: 'window_focus' });
    document.addEventListener('visibilitychange', vis); window.addEventListener('blur', blur); window.addEventListener('focus', foc);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('blur', blur); window.removeEventListener('focus', foc); };
    // eslint-disable-next-line
  }, [isStaff]);

  /* ---- derived streams ---- */
  const tiles = useMemo(() => {
    const out: Array<{ key: string; stream: MediaStream | null; label: string; off?: boolean; screen?: boolean; badge?: string }> = [];
    for (const p of room.peers) {
      const ss = room.streams[p.id] || [];
      const scr = p.media.screenStreamId ? ss.find(s => s.id === p.media.screenStreamId) : undefined;
      const cam = ss.find(s => s.id !== p.media.screenStreamId);
      if (p.kind === 'camera') { if (isStaff && consents.secondaryCamera === true && cam) out.push({ key: p.id, stream: cam, label: 'Secondary camera (workspace view)', badge: secRec && rec.active ? 'recorded' : 'live' }); continue; }
      out.push({ key: p.id, stream: cam || null, label: `${p.name}${p.kind === 'candidate' ? ' (candidate)' : ''}`, off: !p.media.video });
      if (scr) out.push({ key: p.id + 's', stream: scr, label: `${p.name}'s screen`, screen: true });
    }
    return out;
  }, [room.peers, room.streams, consents, secRec, rec.active, isStaff]);
  const screenTile = tiles.find(t => t.screen);
  const candidatePeer = room.peers.find(p => p.kind === 'candidate');

  /* ---- timer ---- */
  const elapsed = startedAt ? (now - new Date(startedAt).getTime()) / 1000 : 0; const remaining = duration * 60 - elapsed;

  /* ---- recording (staff) ---- */
  const [recErr, setRecErr] = useState('');
  const startRecording = async () => {
    if (!interviewId) return; setRecErr('');
    const candStreams = candidatePeer ? room.streams[candidatePeer.id] || [] : [];
    const camS = candStreams.find(s => s.id !== candidatePeer?.media.screenStreamId); const scrS = candStreams.find(s => s.id === candidatePeer?.media.screenStreamId);
    if (!camS) { setRecErr('The candidate has no live stream yet.'); return; }
    try {
      const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
      for (const s of [camS, stream.current]) if (s && s.getAudioTracks().length) ac.createMediaStreamSource(new MediaStream([s.getAudioTracks()[0]])).connect(dest);
      const v = camS.getVideoTracks()[0];
      const main = new MediaStream([...(v ? [v] : []), ...dest.stream.getAudioTracks()]);
      const list: ChunkRecorder[] = [new ChunkRecorder(interviewId, 'main', main, setRecErr)];
      if (scrS) list.push(new ChunkRecorder(interviewId, 'screen', scrS, setRecErr));
      const secPeer = room.peers.find(p => p.kind === 'camera'); const secS = secPeer && (room.streams[secPeer.id] || [])[0];
      if (secS && secRec) list.push(new ChunkRecorder(interviewId, 'secondary_camera', secS, setRecErr));
      for (const r of list) await r.start();
      recorders.current = list;
      room.send({ t: 'rec-state', active: true, paused: false, sources: list.map(r => (r as any).source) });
    } catch (e: any) { setRecErr(e.message || 'Could not start recording'); await Promise.all(recorders.current.map(r => r.stop())); recorders.current = []; }
  };
  const pauseRecording = (p: boolean) => { recorders.current.forEach(r => (p ? r.pause() : r.resume())); room.send({ t: 'rec-state', active: true, paused: p, sources: rec.sources }); };
  const stopRecording = async () => { room.send({ t: 'rec-state', active: false, sources: [] }); await Promise.all(recorders.current.map(r => r.stop())); recorders.current = []; };
  useEffect(() => { if (!rec.active && recorders.current.length) { void Promise.all(recorders.current.map(r => r.stop())).then(() => { recorders.current = []; }); } }, [rec.active]);
  useEffect(() => () => { recorders.current.forEach(r => void r.stop()); }, []);

  /* ---- private notes (autosaved into the feedback draft) ---- */
  const [mine, setMine] = useState<any>(null); const [pnote, setPnote] = useState(''); const saveT = useRef<any>(null);
  useEffect(() => { if (isStaff && interviewId) get(`/interviews/${interviewId}/feedback`).then(f => { setMine(f.mine || { ratings: {}, evidence: '', recommendation: null }); setPnote(f.mine?.private_notes || ''); }).catch(() => {}); }, [isStaff, interviewId]);
  const onNote = (v: string) => { setPnote(v); clearTimeout(saveT.current); saveT.current = setTimeout(() => { if (mine && !mine.submitted) void put(`/interviews/${interviewId}/feedback`, { ratings: mine.ratings || {}, evidence: mine.evidence || '', private_notes: v, recommendation: mine.recommendation || null, submit: false }).catch(() => {}); }, 1500); };

  /* ---- staff: camera QR, invite, questions ---- */
  const [qr, setQr] = useState<any>(null); const [qrErr, setQrErr] = useState('');
  const [team, setTeam] = useState<any[]>([]); const [questions, setQuestions] = useState<any[]>([]); const [bm, setBm] = useState(''); const [followCtx, setFollowCtx] = useState(''); const [follow, setFollow] = useState<any>(null); const [inviteId, setInviteId] = useState('');
  useEffect(() => { if (isStaff) { get('/team').then(t => setTeam(t.members.filter((m: any) => m.status === 'active' && m.role !== 'recruiter'))).catch(() => {}); get('/questions').then(q => setQuestions(q.items)).catch(() => {}); } }, [isStaff]);

  const sendFile = (f: File) => {
    if (f.size > 2 * 1024 * 1024) return flash('Files must be under 2 MB');
    const r = new FileReader(); r.onload = () => room.send({ t: 'chat-file', name: f.name, data: String(r.result).split(',')[1] }); r.readAsDataURL(f);
  };

  /* ---------- render ---------- */
  if (['denied', 'kicked', 'closed', 'error'].includes(room.phase) || ended) {
    return (
      <div className="room" style={{ placeItems: 'center', display: 'grid' }}>
        <div className="card" style={{ maxWidth: 460, textAlign: 'center', color: 'var(--text)' }}>
          <h2>{ended ? 'The interview has ended' : room.phase === 'denied' ? 'The interviewer declined your request' : room.phase === 'kicked' ? 'You were removed from the room' : room.phase === 'error' ? 'Cannot join the room' : 'You left the room'}</h2>
          {room.error && <p>{room.error}</p>}
          <button className="btn primary" onClick={onExit}>{isStaff ? 'Back to interview' : 'Close'}</button>
        </div>
      </div>
    );
  }
  const waiting = room.phase === 'waiting';
  const recVisible = rec.active;
  const sideTabs: Array<[typeof side, string]> = [['chat', `Chat${unread ? ` (${unread})` : ''}`], ...(isStaff ? [['people', `People${room.waiting.length ? ` (${room.waiting.length} waiting)` : ''}`], ['notes', 'Notes'], ['session', 'Session']] as Array<[typeof side, string]> : [['session', 'Privacy'] as [typeof side, string]])];

  return (
    <div className="room" ref={rootRef}>
      <div className="bar">
        <div className="row"><b>{title}</b>
          <span className="badge" style={{ background: status === 'in_progress' ? '#12332a' : '#1d2240', color: status === 'in_progress' ? '#3ddc97' : '#9aa3c7' }}>{status === 'in_progress' ? 'In progress' : status === 'completed' ? 'Ended' : 'Not started'}</span>
          {recVisible && <span className="badge" style={{ background: '#3d1c24', color: '#ff7b7b' }} role="status"><span className="rec-dot" /> {rec.paused ? 'Recording paused' : 'Recording'}</span>}
          {paused && <span className="badge warn">Break</span>}
        </div>
        <div className="row">
          {startedAt && status === 'in_progress' && <span className="mono" title="Elapsed / remaining" style={{ color: remaining < 300 ? '#ff7b7b' : undefined }}>⏱ {mmss(elapsed)} · {remaining >= 0 ? `${mmss(remaining)} left` : `${mmss(-remaining)} over`}</span>}
          <QualityBars q={room.quality} />
          {isStaff && status === 'scheduled' && <button className="btn primary sm" onClick={() => room.send({ t: 'interview-start' })}>Start interview</button>}
          {isStaff && status === 'in_progress' && <button className="btn danger sm" onClick={() => { if (confirm('End the interview for everyone?')) room.send({ t: 'interview-end' }); }}>End interview</button>}
          <button className="btn sm" onClick={fullscreen} aria-label="Toggle full screen">⛶</button>
        </div>
      </div>

      <div className="body">
        <div className="work">
          {(cfg.coding || cfg.whiteboard) && (
            <div className="rtabs" role="tablist" aria-label="Workspace"><button role="tab" aria-selected={tab === 'video'} className={tab === 'video' ? 'active' : ''} onClick={() => setTab('video')}>Video</button>
              {cfg.coding && <button role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>Code</button>}
              {cfg.whiteboard && <button role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>Whiteboard</button>}</div>
          )}
          {(room.phase === 'reconnecting' || room.phase === 'connecting') && <div className="alert warn" style={{ margin: 8 }} role="status">{room.phase === 'connecting' ? 'Connecting…' : 'Connection lost. Reconnecting…'}</div>}
          {mediaErr && <div className="alert warn" style={{ margin: 8 }}>{mediaErr} <button className="btn sm" onClick={acquire}>Try again</button></div>}
          {notices.map((n, i) => <div key={i} className="alert" style={{ margin: '4px 8px' }} role="status">{n}</div>)}
          {waiting && <div className="alert" style={{ margin: 8 }} role="status">⏳ You are in the waiting room. The interviewer will admit you shortly. Your camera and microphone are not shared with anyone yet.</div>}
          {tab === 'video' && (
            <div className={`videos big`}>
              {screenTile && <div style={{ gridColumn: '1 / -1' }}><VideoTile stream={screenTile.stream} label={screenTile.label} screen muted /></div>}
              <VideoTile stream={localStream} label={`${displayName} (you)`} muted off={!camOn} />
              {tiles.filter(t => !t.screen).map(t => <VideoTile key={t.key} stream={t.stream} label={t.label} off={t.off} badge={t.badge} />)}
              {!tiles.some(t => !t.screen) && !waiting && <div className="vtile"><div className="off" style={{ fontSize: '1rem', textAlign: 'center', padding: 12 }}>Waiting for others to join…</div></div>}
            </div>
          )}
          {tab !== 'video' && <div className="videos">{[{ key: 'me', stream: localStream, label: 'You', off: !camOn }, ...tiles.filter(t => !t.screen)].map(t => <VideoTile key={t.key} stream={t.stream} label={t.label} muted={t.key === 'me'} off={(t as any).off} />)}</div>}
          {tab === 'code' && cfg.coding && (
            <CodePanel files={files} active={active} setActive={setActive} readOnly={!isStaff && !allowEdit} hasQuestion={!!question} result={result} running={running} question={question} isStaff={isStaff} allowEdit={allowEdit}
              onToggleEdit={v => room.send({ t: 'code-permission', allow: v })} onPaste={isStaff ? undefined : () => room.send({ t: 'review-signal', type: 'paste' })}
              onChange={(file, content) => setFiles(f => f[file] ? { ...f, [file]: { ...f[file], content } } : f)} onLanguage={(file, language) => room.send({ t: 'code-language', file, language })}
              yBus={{ epoch: yEpoch, subscribe: fn => { yHandlers.current.add(fn); return () => { yHandlers.current.delete(fn); }; }, send: (file, update) => room.send({ t: 'code-yjs', file, update }), sync: file => room.send({ t: 'code-yjs-sync', file }) }}
              onRun={(file, stdin) => { setRunning(true); room.send({ t: 'code-run', file, stdin }); }} onSubmit={file => { setRunning(true); room.send({ t: 'code-submit', file }); }} onAddFile={n => room.send({ t: 'code-file-add', file: n })} />
          )}
          {tab === 'board' && cfg.whiteboard && <Whiteboard items={wb} setItems={setWb} send={room.send} myId={room.me?.id || ''} canClear={isStaff} />}
        </div>

        <aside className="side-panel" aria-label="Room sidebar">
          <div className="rtabs" role="tablist">{sideTabs.map(([k, l]) => <button key={k} role="tab" aria-selected={side === k} className={side === k ? 'active' : ''} onClick={() => { setSide(k); if (k === 'chat') setUnread(0); }}>{l}</button>)}</div>
          {side === 'chat' && <ChatPanel messages={chat} onSend={t => room.send({ t: 'chat', text: t })} onFile={sendFile} />}

          {side === 'people' && isStaff && (
            <div style={{ padding: 10, overflow: 'auto' }} className="stack">
              {room.waiting.length > 0 && <div><b>Waiting room</b>{room.waiting.map(w => <div key={w.id} className="row between" style={{ margin: '6px 0' }}><span>{w.name} <span className="badge">{w.kind}</span></span><span className="row" style={{ gap: 4 }}><button className="btn sm primary" onClick={() => room.send({ t: 'admit', peerId: w.id })}>Admit</button><button className="btn sm" onClick={() => room.send({ t: 'deny', peerId: w.id })}>Decline</button></span></div>)}</div>}
              <div><b>In the room</b>{[{ id: room.me?.id || 'me', name: `${displayName} (you)`, kind: 'staff', media: { audio: micOn, video: camOn, screen: sharing } } as any, ...room.peers].map(p => (
                <div key={p.id} className="row between" style={{ margin: '6px 0' }}><span>{p.name} <span style={{ opacity: .7 }}>{p.media.audio ? '🎙️' : '🔇'} {p.media.video ? '📷' : '🚫'} {p.media.screen ? '🖥️' : ''}</span></span>
                  {p.kind !== 'staff' && p.id !== room.me?.id && <span className="row" style={{ gap: 4 }}>
                    {p.kind === 'candidate' && <button className="btn sm" onClick={() => room.send({ t: 'screen-permission', peerId: p.id, allow: !(p.media.screen || canShareById(p.id)) })}>{p.media.screen ? 'Stop their share' : 'Allow share'}</button>}
                    <button className="btn sm danger" onClick={() => { if (confirm(`Remove ${p.name}?`)) room.send({ t: 'kick', peerId: p.id }); }}>Remove</button></span>}</div>))}</div>
              {shareReqs.map(r => <div key={r.id} className="alert row between">{r.name} wants to share their screen<span className="row" style={{ gap: 4 }}><button className="btn sm primary" onClick={() => { room.send({ t: 'screen-permission', peerId: r.id, allow: true }); setShareReqs(x => x.filter(y => y.id !== r.id)); }}>Allow</button><button className="btn sm" onClick={() => setShareReqs(x => x.filter(y => y.id !== r.id))}>Dismiss</button></span></div>)}
              <div><b>Add another interviewer</b><div className="row" style={{ marginTop: 6, flexWrap: 'nowrap' }}><select value={inviteId} onChange={e => setInviteId(e.target.value)} aria-label="Team member"><option value="">Select team member…</option>{team.map(t => <option key={t.user_id} value={t.user_id}>{t.name} ({t.role.replace('_', ' ')})</option>)}</select>
                <button className="btn sm primary" disabled={!inviteId} onClick={async () => { try { await post(`/interviews/${interviewId}/participants`, { userId: inviteId }); flash('Added. They can now open this room from their dashboard.'); setInviteId(''); } catch (e: any) { flash(e.message); } }}>Add</button></div></div>
            </div>
          )}

          {side === 'notes' && isStaff && (
            <div style={{ padding: 10, overflow: 'auto' }} className="stack">
              <label className="field">Private notes <span className="hint" style={{ color: '#9aa3c7' }}>Only you can see these. Autosaved to your feedback draft.</span><textarea rows={7} value={pnote} onChange={e => onNote(e.target.value)} /></label>
              <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={async e => { e.preventDefault(); if (!bm.trim()) return; await post(`/interviews/${interviewId}/bookmarks`, { label: bm, offsetSec: Math.max(0, Math.floor(elapsed)), kind: 'bookmark' }); setBm(''); flash('Bookmark added to the timeline'); }}><input value={bm} onChange={e => setBm(e.target.value)} placeholder="Timestamped bookmark" aria-label="Bookmark" /><button className="btn sm primary" type="submit">Add</button></form>
              <div><b>Timeline markers</b><div className="row" style={{ gap: 6, marginTop: 6 }}>{[['introductions', 'Introductions'], ['technical_questions', 'Technical Qs'], ['system_design', 'System design'], ['wrap_up', 'Wrap-up']].map(([k, l]) => <button key={k} className="btn sm" onClick={() => room.send({ t: 'marker', kind: k })}>{l}</button>)}
                <button className="btn sm" onClick={() => room.send({ t: 'pause', paused: !paused })}>{paused ? 'End break' : 'Start break'}</button></div></div>
              <div><b>Follow-up ideas (AI)</b><textarea rows={2} placeholder="Paste or describe the candidate's answer" value={followCtx} onChange={e => setFollowCtx(e.target.value)} style={{ marginTop: 6 }} />
                <button className="btn sm" disabled={followCtx.length < 5} onClick={async () => { try { setFollow(await post(`/interviews/${interviewId}/ai/followups`, { context: followCtx })); } catch (e: any) { flash(e.message); } }}>✨ Suggest</button>
                {follow && <div className="msg" style={{ marginTop: 6 }}><span className="badge warn">AI-generated</span><ul style={{ paddingLeft: 18 }}>{follow.content.followups.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul><div className="small" style={{ opacity: .7 }}>Review before use.</div></div>}</div>
              {timeline.length > 0 && <div><b>This session</b>{timeline.slice(-8).map((t, i) => <div key={i} className="small" style={{ opacity: .85 }}>{mmss(t.offset_sec)} {String(t.kind).startsWith('signal:') ? `⚑ review signal: ${t.kind.slice(7).replace('_', ' ')}` : t.kind.replace(/_/g, ' ')}{t.label ? ` — ${t.label}` : ''}</div>)}<div className="small" style={{ opacity: .6 }}>Review signals are context for a human, not proof of misconduct.</div></div>}
            </div>
          )}

          {side === 'session' && isStaff && (
            <div style={{ padding: 10, overflow: 'auto' }} className="stack">
              <div><b>Recording</b>
                {!cfg.recording ? <div className="small" style={{ opacity: .8 }}>Recording is not enabled for this interview.</div> : <>
                  <div className="small">Candidate consent: {consents.recording === true ? <span style={{ color: '#3ddc97' }}>granted</span> : consents.recording === false ? <span style={{ color: '#ff7b7b' }}>declined</span> : 'not yet given'}</div>
                  <div className="row" style={{ marginTop: 6 }}>
                    {!rec.active ? <button className="btn sm primary" disabled={consents.recording !== true || !candidatePeer} onClick={startRecording}>⏺ Start recording</button> : <>
                      <button className="btn sm" onClick={() => pauseRecording(!rec.paused)}>{rec.paused ? '▶ Resume' : '⏸ Pause'}</button><button className="btn sm danger" onClick={stopRecording}>⏹ Stop</button></>}</div>
                  {recErr && <div className="alert error" style={{ marginTop: 6 }}>{recErr}</div>}
                  <div className="small" style={{ opacity: .7, marginTop: 4 }}>The candidate sees a recording indicator. Recording stops if they withdraw consent. Recording is made from this browser and uploaded in chunks; keep this tab open.</div></>}</div>
              {cfg.secondaryCamera && <div><b>Secondary camera (optional)</b>
                <p className="small" style={{ opacity: .8, margin: '4px 0' }}>Shows the candidate's desk/keyboard as an <i>additional angle</i> (not 360°). Scanning never turns on a camera by itself; the candidate must read the notice, consent, and allow the browser permission.</p>
                <button className="btn sm primary" onClick={async () => { setQrErr(''); try { setQr(await post(`/interviews/${interviewId}/camera-qr`)); } catch (e: any) { setQrErr(e.message); } }}>{qr ? 'New QR code' : 'Show QR code'}</button>
                {qrErr && <div className="alert error" style={{ marginTop: 6 }}>{qrErr}</div>}
                {qr && <div style={{ marginTop: 8, textAlign: 'center' }}><img src={qr.qr} alt="QR code for the candidate's phone" style={{ background: '#fff', borderRadius: 8, maxWidth: '100%' }} /><div className="small" style={{ opacity: .7 }}>Valid for 10 minutes, one device. Ask the candidate to scan it with their phone camera.</div></div>}
                <div className="small" style={{ marginTop: 6 }}>Status: {room.peers.some(p => p.kind === 'camera') ? (consents.secondaryCamera === true ? <span style={{ color: '#3ddc97' }}>connected, candidate consented</span> : 'connected, waiting for consent') : 'not connected'}{secRec && ' · recording of this feed consented'}</div>
                {room.peers.filter(p => p.kind === 'camera').map(p => <button key={p.id} className="btn sm danger" style={{ marginTop: 6 }} onClick={() => room.send({ t: 'kick', peerId: p.id })}>Disconnect camera</button>)}
                <div className="small" style={{ opacity: .7, marginTop: 4 }}>Candidate can't use a second device or prefers not to? Continue without it. It is optional.</div></div>}
              {cfg.coding && <div><b>Coding question</b><select style={{ marginTop: 6 }} value={question?.id || ''} onChange={e => { if (e.target.value) room.send({ t: 'code-question', questionId: e.target.value, language: files[active]?.language || 'javascript', applyStarter: true }); }} aria-label="Select question"><option value="">Choose from question bank…</option>{questions.map(q => <option key={q.id} value={q.id}>{q.title} ({q.difficulty})</option>)}</select></div>}
            </div>
          )}

          {side === 'session' && !isStaff && (
            <div style={{ padding: 12, overflow: 'auto' }} className="stack">
              <div className="small">{notice?.recording}</div>
              {cfg.recording && <div className="alert">Recording consent: <b>{consents.recording === true ? 'you agreed' : consents.recording === false ? 'you declined' : 'not answered'}</b>
                <div className="row" style={{ marginTop: 6 }}>{consents.recording !== true && <button className="btn sm primary" onClick={() => room.send({ t: 'consent', kind: 'recording', granted: true })}>I agree to recording</button>}{consents.recording !== false && <button className="btn sm" onClick={() => room.send({ t: 'consent', kind: 'recording', granted: false })}>{consents.recording ? 'Withdraw consent (stops recording)' : 'Decline'}</button>}</div></div>}
              <div className="small">Tab switches and window focus changes may be noted as review signals for the interviewer. They are not treated as proof of anything. If you have an accessibility need or technical problem, tell the interviewer in chat.</div>
            </div>
          )}
        </aside>
      </div>

      <div className="controls" role="toolbar" aria-label="Call controls">
        <button className={`btn ${micOn ? '' : 'red'}`} onClick={toggleMic} aria-pressed={!micOn} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} disabled={!stream.current?.getAudioTracks().length}>{micOn ? '🎙️ Mute' : '🔇 Unmute'}</button>
        <button className={`btn ${camOn ? '' : 'red'}`} onClick={toggleCam} aria-pressed={!camOn} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'} disabled={!stream.current?.getVideoTracks().length}>{camOn ? '📷 Camera off' : '🚫 Camera on'}</button>
        {!sharing ? <button className="btn" onClick={startShare} disabled={reqSent && !canShare && !isStaff}>{isStaff || canShare ? '🖥️ Share screen' : reqSent ? '🖥️ Request sent' : '🖥️ Request screen share'}</button> : <button className="btn on" onClick={stopShare}>⏹ Stop sharing</button>}
        <button className="btn red" onClick={() => { if (confirm('Leave the room?')) { room.leave(); onExit(); } }}>Leave</button>
      </div>

      {showConsent && (
        <div className="modal-bg" style={{ zIndex: 120 }}><div className="modal" role="dialog" aria-modal="true" aria-label="Recording consent" style={{ color: 'var(--text)' }}>
          <h2>Recording consent</h2><p>{notice?.recording}</p>
          <p className="small muted">You can change your mind at any time from the Privacy tab. Declining will not stop the interview.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => { room.send({ t: 'consent', kind: 'recording', granted: false }); setShowConsent(false); }}>Decline</button><button className="btn primary" style={{ background: 'var(--primary)', color: 'var(--primary-ink)' }} onClick={() => { room.send({ t: 'consent', kind: 'recording', granted: true }); setShowConsent(false); }}>I agree</button></div></div></div>
      )}
    </div>
  );
  function canShareById(id: string) { return room.peers.find(p => p.id === id)?.media.screen ?? false; }
}
