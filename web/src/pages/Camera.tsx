import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../api';
import { Button, ErrorBox, Loading } from '../ui';
import { getUserMedia, useRoom } from '../room/useRoom';

/** Mobile companion page. Opening the link never starts a camera: the person must tick consent, press Start and approve the browser prompt. */
export function CameraCompanion() {
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null); const [err, setErr] = useState<any>(null);
  const [consent, setConsent] = useState(false); const [recConsent, setRecConsent] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null); const [started, setStarted] = useState(false); const [msg, setMsg] = useState('');
  const vid = useRef<HTMLVideoElement>(null);
  const room = useRoom({ kind: 'camera', getTicket: () => post(`/public/camera/${token}/connect`, { consent: true }), onMessage: m => {
    if (m.t === 'welcome') { room.send({ t: 'consent', kind: 'secondary_camera', granted: true }); room.send({ t: 'consent', kind: 'secondary_recording', granted: recConsentRef.current }); room.send({ t: 'media', audio: false, video: true, screen: false }); }
    if (m.t === 'kicked') stopAll();
  } });
  const recConsentRef = useRef(false); recConsentRef.current = recConsent;
  useEffect(() => { get(`/public/camera/${token}`).then(setInfo).catch(setErr); }, [token]);
  useEffect(() => { if (vid.current) vid.current.srcObject = stream; }, [stream, started]);

  const stopAll = () => { room.leave(); stream?.getTracks().forEach(t => t.stop()); setStream(null); setStarted(false); setMsg('Camera stopped. You can close this page.'); };
  const start = async () => {
    setMsg('');
    try {
      const s = await getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }); // video only, never the microphone
      setStream(s); room.setLocalStream(s); setStarted(true); await room.connect();
    } catch (e: any) { setMsg(e.message); }
  };
  if (err) return <Wrap><div className="alert error" role="alert">{err.message}</div></Wrap>;
  if (!info) return <Wrap><Loading /></Wrap>;
  const done = room.phase === 'kicked' || room.phase === 'closed' || room.phase === 'denied';
  return (
    <Wrap>
      <h1 style={{ fontSize: '1.3rem' }}>Add a second camera angle</h1>
      <p className="muted" style={{ margin: 0 }}>{info.company} · {info.title}</p>
      {!started && !done && <>
        {info.inUse && <div className="alert warn">This QR code seems to be in use already. Ask the interviewer for a new one.</div>}
        <div className="alert">{info.notice}</div>
        <div className="card flat"><b>How to position your phone</b><ul className="small" style={{ paddingLeft: 18, marginBottom: 0 }}>{info.guidance.map((g: string) => <li key={g}>{g}</li>)}</ul></div>
        <div className="card flat small"><b>What happens next</b><ul style={{ paddingLeft: 18, marginBottom: 0 }}><li>Only your phone’s <b>camera</b> is used. The microphone stays off.</li><li>The interviewer(s) can see it live. It is not shown to other candidates.</li><li>It is <b>not recorded</b> unless you tick the second box below.</li><li>You can stop any time with the “Stop camera” button.</li><li>You can decline and continue the interview without it.</li></ul></div>
        <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>I agree to share my phone camera with the interviewer during this interview.</span></label>
        <label className="check"><input type="checkbox" checked={recConsent} disabled={!consent} onChange={e => setRecConsent(e.target.checked)} /><span>(Optional) I also agree that this camera feed may be recorded, if the interview is recorded.</span></label>
        <ErrorBox error={msg ? { message: msg } : null} />
        <Button variant="primary" disabled={!consent} onClick={start}>Start camera</Button>
        <p className="small muted">Your browser will ask for camera permission next. You can deny it.</p>
      </>}
      {started && !done && <>
        <video ref={vid} autoPlay muted playsInline aria-label="Your phone camera preview" />
        <div className="alert" role="status">{room.phase === 'joined' ? (room.peers.some(p => p.kind === 'staff') ? '🟢 Live: the interviewer can see this view.' : '🟡 Connected. Waiting for the interviewer…') : room.phase === 'reconnecting' ? '🟠 Reconnecting…' : '⏳ Connecting…'}</div>
        <div className="small muted">Keep this page open and your screen on. Not recording unless you agreed above.</div>
        <Button variant="danger" onClick={stopAll}>Stop camera</Button>
      </>}
      {(done || (!started && msg.startsWith('Camera stopped'))) && <div className="alert ok">{msg || 'The camera session has ended.'} You can close this page.</div>}
      {room.error && <div className="alert error">{room.error}</div>}
    </Wrap>
  );
}
const Wrap = ({ children }: { children: React.ReactNode }) => <div className="cam-wrap stack"><div className="brand" style={{ padding: 0 }}><span className="logo">▶</span>IntervueX</div>{children}</div>;
