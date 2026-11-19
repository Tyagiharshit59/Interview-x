import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { bindYText } from './ycode';

/* ---------- video tile ---------- */
export function VideoTile({ stream, label, muted, off, screen, badge }: { stream?: MediaStream | null; label: string; muted?: boolean; off?: boolean; screen?: boolean; badge?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream ?? null; }, [stream]);
  const noVideo = !stream || off || stream.getVideoTracks().length === 0;
  return (
    <div className={`vtile ${screen ? 'screen' : ''}`}>
      <video ref={ref} autoPlay playsInline muted={muted} style={noVideo ? { visibility: 'hidden' } : undefined} aria-label={label} />
      {noVideo && <div className="off" aria-hidden>👤</div>}
      <div className="lbl">{label}{badge && <span className="badge info">{badge}</span>}</div>
    </div>
  );
}

export function QualityBars({ q }: { q: string }) {
  const n = q === 'good' ? 3 : q === 'fair' ? 2 : q === 'poor' ? 1 : 0;
  return <span className="quality" role="img" aria-label={`Connection quality: ${q}`} title={`Connection: ${q}`}>{[1, 2, 3].map(i => <i key={i} className={i <= n ? '' : 'off'} style={{ height: 4 + i * 3 }} />)}</span>;
}

/* ---------- chat ---------- */
export function ChatPanel({ messages, onSend, onFile }: { messages: any[]; onSend: (t: string) => void; onFile: (f: File) => void }) {
  const [t, setT] = useState(''); const end = useRef<HTMLDivElement>(null); const fr = useRef<HTMLInputElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="chat-log" aria-live="polite">
        {messages.length === 0 && <div className="muted small" style={{ color: '#9aa3c7' }}>No messages yet.</div>}
        {messages.map((m, i) => (
          <div key={i} className="msg"><b>{m.name}</b> <span className="small" style={{ color: '#7f88b0' }}>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><br />
            {m.file ? (m.file.mime.startsWith('image/') ? <img alt={m.file.name} src={`data:${m.file.mime};base64,${m.file.data}`} style={{ maxWidth: '100%', borderRadius: 6 }} /> : <a download={m.file.name} href={`data:${m.file.mime};base64,${m.file.data}`}>📎 {m.file.name}</a>) : m.text}</div>
        ))}
        <div ref={end} />
      </div>
      <form className="row" style={{ padding: 8, flexWrap: 'nowrap' }} onSubmit={e => { e.preventDefault(); if (t.trim()) { onSend(t.trim()); setT(''); } }}>
        <input ref={fr} type="file" accept=".png,.jpg,.jpeg,.pdf,.txt" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} aria-label="Attach file" />
        <button type="button" className="btn icon" onClick={() => fr.current?.click()} aria-label="Attach a file (PNG, JPG, PDF, TXT up to 2 MB)" title="PNG, JPG, PDF or TXT up to 2 MB">📎</button>
        <input value={t} onChange={e => setT(e.target.value)} placeholder="Message everyone" aria-label="Chat message" maxLength={2000} />
        <button className="btn primary" type="submit">Send</button>
      </form>
    </div>
  );
}

/* ---------- whiteboard ---------- */
type Item = { id: string; type: 'pen' | 'line' | 'rect' | 'ellipse' | 'text'; color: string; w: number; pts?: number[]; x1?: number; y1?: number; x2?: number; y2?: number; text?: string; by?: string };
const uid = () => Math.random().toString(36).slice(2, 10);

export function Whiteboard({ items, setItems, send, myId }: { items: Item[]; setItems: (f: (p: Item[]) => Item[]) => void; send: (m: any) => void; myId: string; canClear: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null); const [tool, setTool] = useState<'pen' | 'line' | 'rect' | 'ellipse' | 'text' | 'eraser'>('pen'); const [color, setColor] = useState('#1b2033'); const [w, setW] = useState(3);
  const cur = useRef<Item | null>(null); const redo = useRef<Item[]>([]);
  const draw = (ctx: CanvasRenderingContext2D, it: Item, W: number, H: number) => {
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = it.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const X = (v: number) => v * W, Y = (v: number) => v * H;
    if (it.type === 'pen' && it.pts) { ctx.beginPath(); for (let i = 0; i < it.pts.length; i += 2) { const x = X(it.pts[i]), y = Y(it.pts[i + 1]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } if (it.pts.length === 2) ctx.lineTo(X(it.pts[0]) + 0.1, Y(it.pts[1])); ctx.stroke(); }
    else if (it.type === 'line') { ctx.beginPath(); ctx.moveTo(X(it.x1!), Y(it.y1!)); ctx.lineTo(X(it.x2!), Y(it.y2!)); ctx.stroke(); }
    else if (it.type === 'rect') ctx.strokeRect(X(it.x1!), Y(it.y1!), X(it.x2! - it.x1!), Y(it.y2! - it.y1!));
    else if (it.type === 'ellipse') { ctx.beginPath(); ctx.ellipse(X((it.x1! + it.x2!) / 2), Y((it.y1! + it.y2!) / 2), Math.abs(X(it.x2! - it.x1!) / 2), Math.abs(Y(it.y2! - it.y1!) / 2), 0, 0, 7); ctx.stroke(); }
    else if (it.type === 'text') { ctx.font = `${14 + it.w * 2}px system-ui, sans-serif`; ctx.fillText(it.text || '', X(it.x1!), Y(it.y1!)); }
  };
  const render = () => {
    const c = cv.current; if (!c) return; const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const ctx = c.getContext('2d')!; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    for (const it of items) draw(ctx, it, c.width, c.height); if (cur.current) draw(ctx, cur.current, c.width, c.height);
  };
  useEffect(render, [items]);
  useEffect(() => { const h = () => render(); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); });
  const pos = (e: React.PointerEvent) => { const r = cv.current!.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const down = (e: React.PointerEvent) => {
    const [x, y] = pos(e); (e.target as Element).setPointerCapture(e.pointerId);
    if (tool === 'text') { const t = window.prompt('Text'); if (t) commit({ id: uid(), type: 'text', color, w, x1: x, y1: y, text: t.slice(0, 200) }); return; }
    const base = { id: uid(), color: tool === 'eraser' ? '#ffffff' : color, w: tool === 'eraser' ? 18 : w };
    cur.current = tool === 'pen' || tool === 'eraser' ? { ...base, type: 'pen', pts: [x, y] } : { ...base, type: tool as any, x1: x, y1: y, x2: x, y2: y }; render();
  };
  const move = (e: React.PointerEvent) => { const it = cur.current; if (!it) return; const [x, y] = pos(e); if (it.type === 'pen') it.pts!.push(x, y); else { it.x2 = x; it.y2 = y; } render(); };
  const commit = (it: Item) => { redo.current = []; setItems(p => [...p, { ...it, by: myId }]); send({ t: 'wb', op: 'stroke', item: it }); };
  const up = () => { if (cur.current) { commit(cur.current); cur.current = null; } };
  const undo = () => { const mine = [...items].reverse().find(i => i.by === myId); if (!mine) return; redo.current.push(mine); setItems(p => p.filter(i => i.id !== mine.id)); send({ t: 'wb', op: 'undo' }); };
  const redoFn = () => { const it = redo.current.pop(); if (!it) return; setItems(p => [...p, it]); send({ t: 'wb', op: 'stroke', item: it }); };
  const exportPng = () => { const a = document.createElement('a'); a.download = 'whiteboard.png'; a.href = cv.current!.toDataURL('image/png'); a.click(); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="row" style={{ padding: 8, background: '#131830', gap: 6 }} role="toolbar" aria-label="Whiteboard tools">
        {(['pen', 'line', 'rect', 'ellipse', 'text', 'eraser'] as const).map(t => <button key={t} className={`btn sm ${tool === t ? 'primary' : ''}`} aria-pressed={tool === t} onClick={() => setTool(t)}>{({ pen: '✏️ Pen', line: '／ Line', rect: '▭ Box', ellipse: '◯ Oval', text: 'T Text', eraser: '🧽 Erase' } as any)[t]}</button>)}
        <input type="color" aria-label="Colour" value={color} onChange={e => setColor(e.target.value)} style={{ width: 40, minHeight: 32, padding: 2 }} />
        <input type="range" min={1} max={10} value={w} aria-label="Line width" onChange={e => setW(+e.target.value)} style={{ width: 80, padding: 0 }} />
        <button className="btn sm" onClick={undo}>↶ Undo</button><button className="btn sm" onClick={redoFn}>↷ Redo</button><button className="btn sm" onClick={exportPng}>⬇ PNG</button>
      </div>
      <canvas ref={cv} className="wb" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} role="img" aria-label="Shared whiteboard" />
    </div>
  );
}
export const applyWb = (prev: Item[], m: any): Item[] => (m.op === 'stroke' && m.item ? [...prev, m.item] : m.op === 'undo' ? prev.filter(i => i.id !== m.removedId) : m.op === 'clear' ? [] : prev);

/* ---------- code workspace ---------- */
export interface CodeFiles { [name: string]: { content: string; language: string; version: number } }
const LANGS: Array<[string, string]> = [['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'], ['java', 'Java'], ['php', 'PHP'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['sql', 'SQL'], ['go', 'Go'], ['ruby', 'Ruby'], ['rust', 'Rust'], ['kotlin', 'Kotlin'], ['html', 'HTML'], ['css', 'CSS']];
const EXT: Record<string, string> = { javascript: 'js', typescript: 'ts', python: 'py', java: 'java', php: 'php', c: 'c', cpp: 'cpp', csharp: 'cs', sql: 'sql', go: 'go', ruby: 'rb', rust: 'rs', kotlin: 'kt', html: 'html', css: 'css' };

export function CodePanel({ files, active, setActive, onChange, onLanguage, yBus, onRun, onSubmit, onAddFile, readOnly, hasQuestion, result, running, question, isStaff, allowEdit, onToggleEdit, onPaste }: {
  files: CodeFiles; active: string; setActive: (f: string) => void; onChange: (file: string, content: string) => void; onLanguage: (file: string, language: string) => void; yBus: { subscribe: (fn: (m: any) => void) => () => void; send: (file: string, b64: string) => void; sync: (file: string) => void; epoch: number }; onRun: (file: string, stdin: string) => void; onSubmit: (file: string) => void;
  onAddFile: (name: string) => void; readOnly: boolean; hasQuestion: boolean; result: any; running: boolean; question: any; isStaff: boolean; allowEdit: boolean; onToggleEdit: (v: boolean) => void; onPaste?: () => void;
}) {
  const editor = useRef<any>(null); const monaco = useRef<any>(null); const [stdin, setStdin] = useState(''); const [preview, setPreview] = useState(false);
  const file = files[active] || Object.values(files)[0]; 
  const [mounted, setMounted] = useState(false); const [ready, setReady] = useState(false);
  const mount: OnMount = (ed, m) => { editor.current = ed; monaco.current = m; ed.onDidPaste(() => onPaste?.()); setMounted(true); };
  // Bind the editor to this file's shared CRDT text; rebinds when switching files or after a reconnect.
  const activeName = file ? Object.keys(files).find(k => files[k] === file) || active : active;
  const yb = useRef(yBus); yb.current = yBus; const oc = useRef(onChange); oc.current = onChange;
  useEffect(() => {
    const ed = editor.current; if (!mounted || !ed || !activeName) return;
    return bindYText(ed, {
      file: activeName, subscribe: yb.current.subscribe, sendUpdate: b64 => yb.current.send(activeName, b64), requestSync: () => yb.current.sync(activeName),
      onText: t => oc.current(activeName, t), onReady: setReady,
    });
  }, [mounted, activeName, yBus.epoch]);
  if (!file) return <div className="muted" style={{ padding: 16 }}>No files.</div>;
  const runnable = !['html', 'css'].includes(file.language);
  return (
    <div className="code-wrap">
      {question && <div className="qbox"><b>{question.title}</b><div>{question.prompt}</div></div>}
      <div className="row" style={{ padding: '6px 8px', background: '#131830', gap: 6 }}>
        <div className="rtabs" style={{ border: 'none', flex: 1 }} role="tablist">{Object.keys(files).map(n => <button key={n} role="tab" aria-selected={n === active} className={n === active ? 'active' : ''} onClick={() => setActive(n)}>{n}</button>)}</div>
        <button className="btn sm" onClick={() => { const n = window.prompt('New file name', `file${Object.keys(files).length + 1}.${EXT[file.language] || 'txt'}`); if (n) onAddFile(n); }} disabled={readOnly}>+ File</button>
        <select aria-label="Language" style={{ width: 130, minHeight: 32, padding: '2px 8px' }} value={file.language} disabled={readOnly} onChange={e => onLanguage(active, e.target.value)}>{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {isStaff && <label className="check small" style={{ color: '#9aa3c7' }}><input type="checkbox" checked={allowEdit} onChange={e => onToggleEdit(e.target.checked)} />Candidate can edit</label>}
      </div>
      {readOnly && <div className="alert warn" style={{ margin: 0, borderRadius: 0 }}>Editing is currently disabled by the interviewer. You can still view the code.</div>}
      <div style={{ flex: 1, minHeight: 120 }}>
        <Editor theme="vs-dark" path={`${active}`} language={file.language === 'cpp' ? 'cpp' : file.language} defaultValue="" onMount={mount}
          options={{ readOnly: readOnly || !ready, minimap: { enabled: false }, fontSize: 14, automaticLayout: true, tabSize: 2, formatOnPaste: true, scrollBeyondLastLine: false, wordWrap: 'on', accessibilitySupport: 'auto' }} />
      </div>
      <div className="row" style={{ padding: '6px 8px', background: '#131830', gap: 6 }}>
        {runnable ? <><button className="btn sm primary" disabled={running} onClick={() => onRun(active, stdin)}>{running ? 'Running…' : '▶ Run'}</button>{hasQuestion && <button className="btn sm" disabled={running} onClick={() => onSubmit(active)}>✔ Submit</button>}</>
          : <button className="btn sm primary" onClick={() => setPreview(p => !p)}>{preview ? 'Hide preview' : 'Live preview'}</button>}
        <button className="btn sm" onClick={async () => { await editor.current?.getAction('editor.action.formatDocument')?.run(); }}>Format</button>
        {runnable && <input aria-label="Standard input" placeholder="stdin (custom input)" style={{ flex: 1, minHeight: 32, padding: '4px 8px' }} value={stdin} onChange={e => setStdin(e.target.value)} />}
      </div>
      {preview && !runnable ? <iframe title="Preview" sandbox="allow-scripts" srcDoc={Object.entries(files).filter(([, f]) => f.language === 'html').map(([, f]) => f.content).join('') + `<style>${Object.values(files).filter(f => f.language === 'css').map(f => f.content).join('\n')}</style>`} style={{ height: 170, background: '#fff', border: 0 }} /> : (
        <div className="console" role="log" aria-label="Output">
          {!result && <span style={{ color: '#7f88b0' }}>Output appears here for everyone in the room.</span>}
          {result?.kind === 'run' && <><div style={{ color: result.result.ok ? '#3ddc97' : '#ff7b7b' }}>{result.result.status} · {result.by}{result.result.timeMs != null && ` · ${result.result.timeMs} ms`}{result.result.memoryKb != null && ` · ${Math.round(result.result.memoryKb / 1024)} MB`}</div>{result.result.compileOutput && <div style={{ color: '#f5b04c' }}>{result.result.compileOutput}</div>}{result.result.stdout}{result.result.stderr && <div style={{ color: '#ff7b7b' }}>{result.result.stderr}</div>}</>}
          {result?.kind === 'submit' && <><div><b>{result.by} submitted: {result.result.passed}/{result.result.total} tests passed ({result.result.score}%)</b></div>{result.result.outcomes.map((o: any, i: number) => <div key={o.id} style={{ color: o.passed ? '#3ddc97' : '#ff7b7b' }}>{o.passed ? '✔' : '✘'} Test {i + 1}{o.hidden ? ' (hidden)' : ''}: {o.status}{o.timeMs != null && ` · ${o.timeMs} ms`}{!o.passed && !o.hidden && o.expected !== undefined && <div style={{ color: '#9aa3c7', paddingLeft: 14 }}>expected: {JSON.stringify(o.expected)}<br />got: {JSON.stringify(o.actual)}</div>}</div>)}</>}
        </div>)}
    </div>
  );
}
