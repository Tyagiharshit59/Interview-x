export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) { super(message); }
}

async function handle(r: Response) {
  let data: any = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) { try { data = await r.json(); } catch { /* empty */ } }
  if (!r.ok) {
    const msg = data?.details?.length ? `${data.error}: ${data.details.map((d: any) => `${d.path || 'field'} ${d.message}`).join('; ')}` : data?.error || `Request failed (${r.status})`;
    throw new ApiError(r.status, msg, data?.code, data?.details);
  }
  return data;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch('/api' + url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.', 'network'); }
  if (r.status === 401 && !url.startsWith('/auth/') && !url.startsWith('/public/') && !url.startsWith('/portal/')) window.dispatchEvent(new Event('ivx:unauthenticated'));
  return handle(r);
}
export const get = <T = any>(u: string) => api<T>('GET', u);
export const post = <T = any>(u: string, b?: unknown) => api<T>('POST', u, b ?? {});
export const put = <T = any>(u: string, b?: unknown) => api<T>('PUT', u, b ?? {});
export const patch = <T = any>(u: string, b?: unknown) => api<T>('PATCH', u, b ?? {});
export const del = <T = any>(u: string) => api<T>('DELETE', u);

export async function upload<T = any>(url: string, file: File): Promise<T> {
  const fd = new FormData(); fd.append('file', file);
  let r: Response;
  try { r = await fetch('/api' + url, { method: 'POST', body: fd, credentials: 'same-origin' }); } catch { throw new ApiError(0, 'Upload failed: cannot reach the server.', 'network'); }
  return handle(r);
}

export const fmtDate = (iso?: string | null, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) => (iso ? new Date(iso).toLocaleString(undefined, opts) : '—');
export const money = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
