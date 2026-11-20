import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X, Inbox } from 'lucide-react';

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
      <div className="toasts" role="status" aria-live="polite">{items.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.kind === 'error' ? <AlertCircle className="h-4 w-4 flex-none" /> : <CheckCircle2 className="h-4 w-4 flex-none text-emerald-400" />}<span>{t.msg}</span></div>)}</div>
    </ToastCtx.Provider>
  );
}

/* ---------- primitives ---------- */
export function Button({ variant, size, busy, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; size?: 'sm'; busy?: boolean }) {
  return <button {...p} disabled={p.disabled || busy} className={`btn ${variant || ''} ${size || ''} ${p.className || ''}`}>{busy && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}{children}</button>;
}
export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;
export const Loading = () => (
  <div className="flex flex-col gap-4 animate-fade-up" aria-busy="true" aria-label="Loading">
    <div className="h-8 w-56 rounded-xl bg-raised animate-pulse" />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-28 rounded-2xl bg-raised animate-pulse" />)}</div>
    <div className="h-64 rounded-2xl bg-raised animate-pulse" />
  </div>
);
export const Empty = ({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) => (
  <div className="empty">
    <span className="mb-2 grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/10 text-brand-500 ring-1 ring-brand-500/20">{icon ?? <Inbox className="h-6 w-6" />}</span>
    <h3>{title}</h3>
    {children && <div className="max-w-md text-[14px]">{children}</div>}
  </div>
);

/** Page title row: eyebrow, title, description and actions. */
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-gold-500">{eyebrow}</div>}
        <h1 className="mb-0">{title}</h1>
        {description && <p className="mt-1.5 mb-0 max-w-2xl text-[15px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export const ErrorBox = ({ error }: { error: unknown }) => error ? <div className="alert error" role="alert">{(error as any)?.message || String(error)}</div> : null;
export const Badge = ({ kind, children }: { kind?: 'ok' | 'warn' | 'danger' | 'info' | 'primary' | 'gold'; children: ReactNode }) => <span className={`badge ${kind || ''}`}>{children}</span>;
export const Card = ({ children, title, actions, className }: { children: ReactNode; title?: ReactNode; actions?: ReactNode; className?: string }) => (
  <section className={`card ${className || ''}`}>{(title || actions) && <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="!mb-0 text-[17px]">{title}</h2><div className="flex flex-wrap items-center gap-2">{actions}</div></div>}{children}</section>
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
        <div className="mb-4 flex items-center justify-between gap-3"><h2 className="!mb-0 text-xl">{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button></div>
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
      <div className="mt-5 flex justify-end gap-2">
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

export const statusBadge = (s: string | null | undefined) => {
  if (!s) return <Badge>unknown</Badge>;
  const m: Record<string, 'ok' | 'warn' | 'danger' | 'info' | undefined> = { scheduled: 'info', in_progress: 'warn', completed: 'ok', cancelled: 'danger', published: 'ok', draft: undefined, archived: undefined, active: 'ok', trialing: 'info', past_due: 'warn', expired: 'danger', paid: 'ok', pending: 'warn', failed: 'danger', ready: 'ok', suspended: 'danger' };
  return <Badge kind={m[s]}>{s.replace(/_/g, ' ')}</Badge>;
};

/** Company logo with a tasteful initial fallback. */
export function CompanyLogo({ name, src, size = 40, className = '' }: { name: string; src?: string | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (src && !broken) return <span className={`grid flex-none place-items-center overflow-hidden rounded-xl bg-white ring-1 ring-line ${className}`} style={style}><img src={src} alt={`${name} logo`} onError={() => setBroken(true)} className="h-full w-full object-contain p-1" /></span>;
  return <span className={`grid flex-none place-items-center rounded-xl bg-gradient-to-br from-brand-500/15 to-gold-400/25 font-extrabold text-brand-700 ring-1 ring-brand-500/15 dark:text-brand-200 ${className}`} style={{ ...style, fontSize: Math.round(size * 0.4) }}>{(name || '?').slice(0, 1).toUpperCase()}</span>;
}
