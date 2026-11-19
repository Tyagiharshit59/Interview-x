import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../api';
import { Button, ErrorBox, Field, Loading } from '../ui';
import { RoomView } from '../room/RoomView';
import { getUserMedia } from '../room/useRoom';

export function Join() {
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null); const [err, setErr] = useState<any>(null);
  const [email, setEmail] = useState(''); const [verified, setVerified] = useState(false); const [idErr, setIdErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null); const [devErr, setDevErr] = useState(''); const [level, setLevel] = useState(0); const [inRoom, setInRoom] = useState(false); const [left, setLeft] = useState(false);
  const [agree, setAgree] = useState(false); const [skipCam, setSkipCam] = useState(false);
  const vid = useRef<HTMLVideoElement>(null); const raf = useRef<number>(0);

  useEffect(() => { get(`/public/join/${token}`).then(setInfo).catch(setErr); }, [token]);
  useEffect(() => { if (vid.current) vid.current.srcObject = stream; }, [stream, verified]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const test = async () => {
    setDevErr('');
    try {
      const s = await getUserMedia({ audio: true, video: skipCam ? false : { width: { ideal: 1280 }, height: { ideal: 720 } } });
      stream?.getTracks().forEach(t => t.stop()); setStream(s);
      const ac = new AudioContext(); const an = ac.createAnalyser(); ac.createMediaStreamSource(s).connect(an); const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => { an.getByteFrequencyData(buf); setLevel(Math.min(100, Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) * 2))); raf.current = requestAnimationFrame(tick); }; tick();
    } catch (e: any) { setDevErr(e.message); }
  };

  if (err) return <Frame><div className="alert error" role="alert">{err.message}</div><p className="muted small">If you think this is a mistake, ask your recruiter to resend the invitation.</p></Frame>;
  if (!info) return <Frame><Loading /></Frame>;
  if (left) return <Frame><h2>Thanks for joining</h2><p>You have left the interview room. You can close this tab.</p></Frame>;

  if (inRoom) {
    return <RoomView kind="candidate" displayName={info.candidateFirstName} title={`${info.company} — ${info.title}`} preStream={stream} notice={info.notice}
      getTicket={async () => { try { return await post(`/public/join/${token}/ticket`, { email }); } catch (e: any) { throw e; } }} onExit={() => { stream?.getTracks().forEach(t => t.stop()); setLeft(true); setInRoom(false); }} />;
  }

  const start = new Date(info.scheduledAt);
  const browserOk = !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';
  return (
    <Frame>
      <h1 style={{ fontSize: '1.4rem' }}>{info.title}</h1>
      <p className="muted" style={{ margin: 0 }}>{info.company} · {info.jobTitle}</p>
      <div className="alert">📅 {start.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} ({Intl.DateTimeFormat().resolvedOptions().timeZone}) · {info.durationMin} minutes</div>
      {info.instructions && <div className="card flat"><b>Instructions</b><div style={{ whiteSpace: 'pre-wrap' }}>{info.instructions}</div></div>}
      {!browserOk && <div className="alert error">This browser can’t run video interviews. Please use a recent Chrome, Edge, Firefox or Safari over a secure (https) connection.</div>}

      {!verified ? (
        <form className="stack" onSubmit={async e => { e.preventDefault(); setBusy(true); setIdErr(null); try { await post(`/public/join/${token}/ticket`, { email }).then(() => setVerified(true)); } catch (x: any) { if (x.code === 'too_early') { setVerified(true); } else setIdErr(x); } finally { setBusy(false); } }}>
          <h2>1. Confirm it’s you</h2>
          <Field label="Email address this invitation was sent to"><input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
          <ErrorBox error={idErr} /><Button variant="primary" busy={busy} type="submit">Continue</Button>
        </form>
      ) : (
        <div className="stack">
          <h2>2. Check your camera and microphone</h2>
          <p className="muted small" style={{ margin: 0 }}>Nothing is recorded or shared with the interviewer during this check.</p>
          <video ref={vid} autoPlay muted playsInline style={{ width: '100%', borderRadius: 12, background: '#000', aspectRatio: '16/9', objectFit: 'cover' }} aria-label="Camera preview" />
          {stream && <div><div className="small">Microphone level (speak to test)</div><div className="meter" role="meter" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100}><i style={{ width: level + '%' }} /></div></div>}
          {devErr && <div className="alert error" role="alert">{devErr}</div>}
          <div className="row"><Button onClick={test}>{stream ? 'Re-test devices' : 'Test camera & microphone'}</Button>
            <label className="check small"><input type="checkbox" checked={skipCam} onChange={e => { setSkipCam(e.target.checked); setStream(null); }} />Join with audio only (accessibility or no camera)</label></div>
          <h2>3. What to expect</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>You will wait in a waiting room until the interviewer admits you.</li>
            {info.features.coding && <li>A shared code editor may be used. You will be able to run code and see results with the interviewer.</li>}
            {info.features.recording && <li>The interview may be <b>recorded only if you agree</b>. You will be asked when you join, and can change your mind later.</li>}
            {info.features.secondaryCamera && <li>The interviewer may offer an <b>optional</b> second camera view from your phone (e.g. desk and keyboard). It is never switched on without your consent. You can decline.</li>}
            <li>Tab switches and window-focus changes may be noted as review signals for the interviewer. They are context, not proof of anything.</li>
            <li>If you need an adjustment (accessibility, no second device, slow connection), tell your recruiter or the interviewer.</li>
          </ul>
          <label className="check"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /><span>I understand how my camera and microphone will be used in this interview.</span></label>
          <Button variant="primary" disabled={!agree || !browserOk || (!stream && !devErr)} onClick={() => { setInRoom(true); }}>Join waiting room</Button>
          {!stream && !devErr && <span className="small muted">Run the device check first (or choose audio only).</span>}
          {new Date().getTime() < start.getTime() - 30 * 60000 && <div className="alert warn">The room opens 30 minutes before the start time, at {new Date(start.getTime() - 30 * 60000).toLocaleTimeString()}. You can run the device check now.</div>}
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="auth-wrap" style={{ alignItems: 'start' }}><div className="card stack" style={{ width: 'min(640px, 100%)' }}><div className="brand" style={{ padding: 0 }}><span className="logo">▶</span>IntervueX</div>{children}</div></div>;
}
