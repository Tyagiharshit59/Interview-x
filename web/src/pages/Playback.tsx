import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { get, post } from '../api';
import { Badge, Button, Card, ErrorBox, Loading, useLoad, useToast } from '../ui';

const LABEL: Record<string, string> = {
  interview_started: 'Interview started', interview_ended: 'Interview ended', candidate_joined: 'Candidate joined', candidate_left: 'Candidate left', introductions: 'Introductions', technical_questions: 'Technical questions',
  coding_started: 'Coding started', code_submitted: 'Code submitted', screen_share_started: 'Screen share started', screen_share_stopped: 'Screen share stopped', break_started: 'Break', break_ended: 'Break ended', system_design: 'System design',
  wrap_up: 'Wrap-up', recording_started: 'Recording started', recording_paused: 'Recording paused', recording_stopped: 'Recording stopped', secondary_camera_disconnected: 'Secondary camera disconnected', bookmark: 'Bookmark', note: 'Note', custom: 'Marker',
};
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Playback() {
  const { id } = useParams(); const toast = useToast(); const vref = useRef<HTMLVideoElement>(null);
  const { data, error, reload } = useLoad(() => get(`/interviews/${id}/playback`), [id]);
  const [sel, setSel] = useState(0); const [snap, setSnap] = useState<any>(null); const [note, setNote] = useState(''); const [showSignals, setShowSignals] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const rec = data.recordings[sel];
  const events = data.events.filter((e: any) => showSignals || !e.kind.startsWith('signal:'));
  return (
    <div className="stack">
      <div className="row between"><h1>Playback: {data.interview.title}</h1><Link to={`/interviews/${id}`}>← Back</Link></div>
      <div className="alert">Access to this recording is logged. Do not download or share it outside the hiring process.</div>
      <div className="grid g2" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
        <div className="stack">
          <Card title="Recording">
            {data.recordings.length === 0 ? <div className="muted">No recording is available for this interview.</div> : <>
              {data.recordings.length > 1 && <div className="row" style={{ marginBottom: 8 }}>{data.recordings.map((r: any, i: number) => <Button key={r.id} size="sm" variant={i === sel ? 'primary' : undefined} onClick={() => setSel(i)}>{r.source.replace('_', ' ')}</Button>)}</div>}
              <video ref={vref} key={rec.url} src={rec.url} controls controlsList="nodownload" style={{ width: '100%', borderRadius: 10, background: '#000' }} />
              <p className="small muted">The link above is short-lived. Reload this page for a fresh one.</p></>}
          </Card>
          <Card title="Code history">{data.snapshots.length === 0 ? <div className="muted">No code snapshots.</div> : <>
            <input type="range" min={0} max={data.snapshots.length - 1} defaultValue={data.snapshots.length - 1} aria-label="Code snapshot" onChange={async e => setSnap(await get(`/interviews/${id}/snapshots/${data.snapshots[+e.target.value].id}`))} style={{ padding: 0 }} />
            <div className="small muted">Slide to step through {data.snapshots.length} snapshots {snap && `· ${snap.file_name} · ${new Date(snap.created_at).toLocaleTimeString()}`}</div>
            <div style={{ height: 280, marginTop: 8 }}><Editor theme="vs-dark" language={snap?.language === 'cpp' ? 'cpp' : snap?.language || 'javascript'} value={snap?.content ?? '// Move the slider to load a snapshot'} options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }} /></div></>}</Card>
        </div>
        <div className="stack">
          <Card title="Timeline" actions={<label className="check small"><input type="checkbox" checked={showSignals} onChange={e => setShowSignals(e.target.checked)} />Review signals</label>}>
            <div className="timeline">{events.length === 0 && <div className="muted">No events yet.</div>}
              {events.map((e: any) => <div key={e.id} className={`tl-item ${e.kind.startsWith('signal:') ? 'signal' : ''}`} role="button" tabIndex={0} onClick={() => { if (vref.current) { vref.current.currentTime = e.offset_sec; void vref.current.play(); } }} onKeyDown={ev => { if (ev.key === 'Enter' && vref.current) vref.current.currentTime = e.offset_sec; }}>
                <span className="t">{fmt(e.offset_sec)}</span><span>{e.kind.startsWith('signal:') ? `Review signal: ${e.kind.slice(7).replace('_', ' ')}` : LABEL[e.kind] || e.kind}{e.label ? ` — ${e.label}` : ''}</span></div>)}</div>
            {showSignals && <p className="small muted">Tab and focus events are review signals only. They are not proof of misconduct; people switch windows for many innocent reasons.</p>}
            <form className="row" style={{ marginTop: 10 }} onSubmit={async e => { e.preventDefault(); if (!note.trim()) return; await post(`/interviews/${id}/bookmarks`, { label: note, offsetSec: Math.floor(vref.current?.currentTime || 0), kind: 'note' }); setNote(''); toast('Note added'); void reload(); }}>
              <input className="grow" placeholder="Timestamped note at current position" value={note} onChange={e => setNote(e.target.value)} aria-label="Timestamped note" /><Button type="submit" size="sm">Add</Button></form>
          </Card>
          {data.transcript.length > 0 && <Card title="Transcript"><div className="stack gap-sm" style={{ maxHeight: 300, overflow: 'auto' }}>{data.transcript.map((t: any, i: number) => <div key={i} className="small"><Badge>{t.speaker}</Badge> {t.text}</div>)}</div></Card>}
        </div>
      </div>
    </div>
  );
}
