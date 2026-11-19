import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/* ---------- toasts ---------- */
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const push = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems(i => [...i, { id, msg, kind }]);
    setTimeout(() => setItems(i => i.filter(x => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/* ---------- primitives ---------- */
export function Button({ variant, size, busy, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; size?: 'sm'; busy?: boolean }) {
  return <button {...p} disabled={p.disabled || busy} className={`btn ${variant || ''} ${size || ''} ${p.className || ''}`}>{busy && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}{children}</button>;
}
export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;
export const Loading = () => <div className="empty"><Spinner /></div>;
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => <div className="empty"><h3>{title}</h3>{children}</div>;
export const ErrorBox = ({ error }: { error: unknown }) => error ? <div className="alert error" role="alert">{(error as any)?.message || String(error)}</div> : null;
export const Badge = ({ kind, children }: { kind?: 'ok' | 'warn' | 'danger' | 'info' | 'primary'; children: ReactNode }) => <span className={`badge ${kind || ''}`}>{children}</span>;
export const Card = ({ children, title, actions, className }: { children: ReactNode; title?: ReactNode; actions?: ReactNode; className?: string }) => (
  <section className={`card ${className || ''}`}>{(title || actions) && <div className="row between" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>{title}</h2><div className="row">{actions}</div></div>}{children}</section>
);

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <span className="hint">{hint}</span>}{error && <span className="err" role="alert">{error}</span>}</label>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={wide ? { width: 'min(820px,100%)' } : undefined}>
        <div className="row between"><h2>{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function useConfirm() {
  const [state, setState] = useState<null | { msg: string; resolve: (v: boolean) => void; danger?: boolean }>(null);
  const confirm = (msg: string, danger = true) => new Promise<boolean>(resolve => setState({ msg, resolve, danger }));
  const node = state ? (
    <Modal title="Please confirm" onClose={() => { state.resolve(false); setState(null); }}>
      <p>{state.msg}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={() => { state.resolve(false); setState(null); }}>Cancel</Button>
        <Button variant={state.danger ? 'danger' : 'primary'} onClick={() => { state.resolve(true); setState(null); }}>Confirm</Button>
      </div>
    </Modal>
  ) : null;
  return { confirm, node };
}

/** Load data with loading/error state. */
export function useLoad<T>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); } catch (e) { setError(e); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function ChipInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [t, setT] = useState('');
  const add = () => { const v = t.trim().toLowerCase(); if (v && !value.includes(v)) onChange([...value, v]); setT(''); };
  return (
    <div>
      <div className="chips" style={{ marginBottom: value.length ? 6 : 0 }}>{value.map(v => <span className="chip" key={v}>{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter(x => x !== v))}>✕</button></span>)}</div>
      <input value={t} placeholder={placeholder || 'Type and press Enter'} onChange={e => setT(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

export const Meter = ({ used, limit }: { used: number; limit: number | null }) => {
  if (limit == null) return <span className="muted small">{used} used</span>;
  if (limit === -1) return <span className="muted small">{used} used · unlimited</span>;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  return <div><div className="meter" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: pct + '%' }} /></div><span className="muted small">{used} / {limit}</span></div>;
};

export const statusBadge = (s: string) => {
  const m: Record<string, 'ok' | 'warn' | 'danger' | 'info' | undefined> = { scheduled: 'info', in_progress: 'warn', completed: 'ok', cancelled: 'danger', published: 'ok', draft: undefined, archived: undefined, active: 'ok', trialing: 'info', past_due: 'warn', expired: 'danger', paid: 'ok', pending: 'warn', failed: 'danger', ready: 'ok', suspended: 'danger' };
  return <Badge kind={m[s]}>{s.replace(/_/g, ' ')}</Badge>;
};
