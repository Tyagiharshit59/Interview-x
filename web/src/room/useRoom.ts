import { useCallback, useEffect, useRef, useState } from 'react';

export interface PeerInfo { id: string; kind: 'staff' | 'candidate' | 'camera'; name: string; role: string; media: { audio: boolean; video: boolean; screen: boolean; screenStreamId?: string } }
export type Phase = 'idle' | 'connecting' | 'waiting' | 'joined' | 'reconnecting' | 'denied' | 'kicked' | 'closed' | 'error';
export type Quality = 'good' | 'fair' | 'poor' | 'unknown';
export interface Ticket { ticket: string; iceServers: RTCIceServer[]; [k: string]: any }

interface Opts {
  kind: 'staff' | 'candidate' | 'camera';
  getTicket: () => Promise<Ticket>;
  onMessage?: (m: any) => void;
}
interface Conn { pc: RTCPeerConnection; makingOffer: boolean; ignoreOffer: boolean; polite: boolean; senders: RTCRtpSender[]; screenSenders: RTCRtpSender[] }

/**
 * Signalling + WebRTC mesh (fine for ~2–6 people). For larger panels or server-side recording,
 * swap this hook for an SFU client such as LiveKit (see README).
 * Uses the "perfect negotiation" pattern so either side can add/remove tracks (e.g. screen share) safely.
 */
export function useRoom({ kind, getTicket, onMessage }: Opts) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [waiting, setWaiting] = useState<Array<{ id: string; name: string; kind: string }>>([]);
  const [streams, setStreams] = useState<Record<string, MediaStream[]>>({});
  const [quality, setQuality] = useState<Quality>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<any>(null);

  const ws = useRef<WebSocket | null>(null);
  const conns = useRef<Map<string, Conn>>(new Map());
  const ice = useRef<RTCIceServer[]>([]);
  const local = useRef<MediaStream | null>(null);
  const screen = useRef<MediaStream | null>(null);
  const meRef = useRef<{ id: string } | null>(null);
  const peersRef = useRef<PeerInfo[]>([]);
  const onMsg = useRef(onMessage); onMsg.current = onMessage;
  const closed = useRef(false);
  const retry = useRef(0);
  const getTicketRef = useRef(getTicket); getTicketRef.current = getTicket;

  const send = useCallback((m: any) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m)); }, []);

  const setPeerList = (l: PeerInfo[]) => { peersRef.current = l; setPeers(l); };

  const closeConn = (id: string) => {
    const c = conns.current.get(id); if (!c) return;
    c.pc.ontrack = null; c.pc.onicecandidate = null; c.pc.onnegotiationneeded = null; c.pc.close(); conns.current.delete(id);
    setStreams(s => { const n = { ...s }; delete n[id]; return n; });
  };
  const closeAll = () => { for (const id of [...conns.current.keys()]) closeConn(id); };

  const attachLocal = (c: Conn, peer: PeerInfo) => {
    // The secondary camera never receives other people's media; staff never send media to it.
    if (peer.kind === 'camera') { if (kind === 'staff') c.pc.addTransceiver('video', { direction: 'recvonly' }); }
    if (kind === 'camera' && peer.kind === 'staff') { /* camera sends video only */ }
    if (peer.kind === 'camera' && kind === 'staff') return;
    const ls = local.current;
    if (ls) for (const t of ls.getTracks()) c.senders.push(c.pc.addTrack(t, ls));
    if (screen.current && kind !== 'camera') for (const t of screen.current.getTracks()) c.screenSenders.push(c.pc.addTrack(t, screen.current));
  };

  const ensureConn = (peer: PeerInfo): Conn => {
    let c = conns.current.get(peer.id); if (c) return c;
    const pc = new RTCPeerConnection({ iceServers: ice.current });
    const myId = meRef.current!.id;
    c = { pc, makingOffer: false, ignoreOffer: false, polite: kind === 'staff' && peer.kind === 'staff' ? myId > peer.id : kind !== 'staff', senders: [], screenSenders: [] };
    const conn = c;
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'signal', to: peer.id, data: { candidate: e.candidate } }); };
    pc.ontrack = e => {
      const s = e.streams[0] || new MediaStream([e.track]);
      setStreams(prev => { const l = prev[peer.id] || []; return l.some(x => x.id === s.id) ? { ...prev, [peer.id]: [...l] } : { ...prev, [peer.id]: [...l, s] }; });
      s.onremovetrack = () => setStreams(prev => ({ ...prev, [peer.id]: (prev[peer.id] || []).filter(x => x.getTracks().length > 0) }));
    };
    pc.onnegotiationneeded = async () => {
      try { conn.makingOffer = true; await pc.setLocalDescription(); send({ t: 'signal', to: peer.id, data: { description: pc.localDescription } }); }
      catch { /* negotiation retried on next change */ } finally { conn.makingOffer = false; }
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
    conns.current.set(peer.id, conn);
    attachLocal(conn, peer);
    return conn;
  };

  const onSignal = async (from: string, data: any) => {
    const peer = peersRef.current.find(p => p.id === from); if (!peer) return;
    const c = ensureConn(peer); const pc = c.pc;
    try {
      if (data.description) {
        const d = data.description as RTCSessionDescriptionInit;
        const collision = d.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
        c.ignoreOffer = !c.polite && collision;
        if (c.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') { await pc.setLocalDescription(); send({ t: 'signal', to: from, data: { description: pc.localDescription } }); }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!c.ignoreOffer) throw e; }
      }
    } catch { /* ignore malformed/late signals */ }
  };

  const handle = (m: any) => {
    switch (m.t) {
      case 'waiting-room': setMe(m.you); meRef.current = m.you; setPhase('waiting'); break;
      case 'welcome': {
        setMe(m.you); meRef.current = m.you; setWelcome(m.state); closeAll(); setPeerList(m.peers); setPhase('joined'); retry.current = 0;
        for (const p of m.peers) ensureConn(p);
        break;
      }
      case 'peer-joined': setPeerList([...peersRef.current.filter(p => p.id !== m.peer.id), m.peer]); ensureConn(m.peer); break;
      case 'peer-left': closeConn(m.id); setPeerList(peersRef.current.filter(p => p.id !== m.id)); break;
      case 'media': setPeerList(peersRef.current.map(p => (p.id === m.id ? { ...p, media: m.media } : p))); break;
      case 'signal': void onSignal(m.from, m.data); break;
      case 'waiting': setWaiting(m.waiting); break;
      case 'denied': closed.current = true; setPhase('denied'); break;
      case 'kicked': closed.current = true; setPhase('kicked'); break;
      case 'replaced': closed.current = true; setPhase('closed'); setError('You joined from another tab or device.'); break;
      default: break;
    }
    onMsg.current?.(m);
  };

  const connect = useCallback(async () => {
    closed.current = false; setPhase(p => (p === 'joined' || p === 'reconnecting' ? 'reconnecting' : 'connecting')); setError(null);
    let t: Ticket;
    try { t = await getTicketRef.current(); } catch (e: any) { setError(e.message || 'Could not join'); setPhase('error'); return; }
    ice.current = t.iceServers || [];
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws?ticket=${encodeURIComponent(t.ticket)}`);
    ws.current = sock;
    sock.onmessage = e => { try { handle(JSON.parse(e.data)); } catch { /* ignore */ } };
    sock.onclose = ev => {
      if (ws.current !== sock) return;
      if (closed.current || [4403, 4429, 4000].includes(ev.code)) { if (ev.code === 4429) { setError('This room is full.'); setPhase('error'); } else if (ev.code === 4403 && !closed.current) { setError(ev.reason || 'Access denied'); setPhase('error'); } return; }
      setPhase('reconnecting');
      const delay = Math.min(8000, 800 * 2 ** retry.current++);
      if (retry.current > 8) { setError('Connection lost. Please reload the page.'); setPhase('error'); return; }
      setTimeout(() => { if (!closed.current) void connect(); }, delay);
    };
    sock.onerror = () => { /* close handler deals with it */ };
    // eslint-disable-next-line
  }, []);

  const leave = useCallback(() => {
    closed.current = true; ws.current?.close(); ws.current = null; closeAll(); setPhase('closed');
    local.current?.getTracks().forEach(t => t.stop()); screen.current?.getTracks().forEach(t => t.stop());
    // eslint-disable-next-line
  }, []);
  useEffect(() => () => { closed.current = true; ws.current?.close(); closeAll(); /* eslint-disable-next-line */ }, []);

  /** Provide/replace the local camera+mic stream. Tracks are added to existing connections. */
  const setLocalStream = useCallback((s: MediaStream | null) => {
    local.current = s;
    for (const [id, c] of conns.current) {
      const peer = peersRef.current.find(p => p.id === id); if (!peer || (peer.kind === 'camera' && kind === 'staff')) continue;
      c.senders.forEach(snd => { try { c.pc.removeTrack(snd); } catch { /* */ } }); c.senders = [];
      if (s) for (const t of s.getTracks()) c.senders.push(c.pc.addTrack(t, s));
    }
    // eslint-disable-next-line
  }, []);

  const startScreen = useCallback(async () => {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    screen.current = s;
    for (const [id, c] of conns.current) { const peer = peersRef.current.find(p => p.id === id); if (!peer || peer.kind === 'camera') continue; for (const t of s.getTracks()) c.screenSenders.push(c.pc.addTrack(t, s)); }
    s.getVideoTracks()[0].onended = () => stopScreen();
    return s;
    // eslint-disable-next-line
  }, []);
  const stopScreen = useCallback(() => {
    const s = screen.current; if (!s) return;
    s.getTracks().forEach(t => t.stop());
    for (const c of conns.current.values()) { c.screenSenders.forEach(snd => { try { c.pc.removeTrack(snd); } catch { /* */ } }); c.screenSenders = []; }
    screen.current = null; window.dispatchEvent(new Event('ivx:screen-stopped'));
  }, []);

  /* connection quality from RTCStats */
  useEffect(() => {
    const t = setInterval(async () => {
      let worst: Quality = 'unknown';
      for (const c of conns.current.values()) {
        try {
          const stats = await c.pc.getStats(); let rtt = 0, lost = 0, recv = 0;
          stats.forEach(r => {
            if (r.type === 'candidate-pair' && (r as any).state === 'succeeded' && (r as any).nominated) rtt = ((r as any).currentRoundTripTime || 0) * 1000;
            if (r.type === 'inbound-rtp' && !(r as any).isRemote) { lost += (r as any).packetsLost || 0; recv += (r as any).packetsReceived || 0; }
          });
          const loss = recv + lost > 0 ? lost / (recv + lost) : 0;
          const q: Quality = rtt > 400 || loss > 0.1 ? 'poor' : rtt > 200 || loss > 0.03 ? 'fair' : 'good';
          worst = worst === 'unknown' || (q === 'poor') || (q === 'fair' && worst === 'good') ? q : worst;
        } catch { /* closed */ }
      }
      setQuality(worst);
    }, 3000);
    return () => clearInterval(t);
  }, []);

  return { phase, me, peers, waiting, streams, quality, error, welcome, send, connect, leave, setLocalStream, startScreen, stopScreen, getScreen: () => screen.current, getLocal: () => local.current };
}

export async function getUserMedia(opts: { audio: boolean; video: boolean | MediaTrackConstraints }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Your browser does not support camera access. Try the latest Chrome, Edge, Firefox or Safari over HTTPS.');
  try { return await navigator.mediaDevices.getUserMedia(opts); }
  catch (e: any) {
    if (e.name === 'NotAllowedError') throw new Error('Permission was blocked. Allow camera/microphone access in your browser’s address bar and try again.');
    if (e.name === 'NotFoundError') throw new Error('No camera or microphone was found.');
    if (e.name === 'NotReadableError') throw new Error('Your camera or microphone is being used by another application.');
    throw e;
  }
}
