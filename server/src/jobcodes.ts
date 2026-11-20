import { db, raw, j } from './db.js';

/**
 * Human-readable job IDs: `<PREFIX>-<0001>`, e.g. INFO-0007.
 * The prefix is chosen by each company (Settings → Company → Job ID prefix); the number is a per-company counter that only
 * goes up, so IDs are never reused even if the prefix changes. Templates do not get an ID.
 */
export const PREFIX_RE = /^[A-Z0-9]{2,8}$/;

/** Default prefix from the company name: first 4 letters of a one-word name, otherwise the initials (max 4). */
export function derivePrefix(name: string) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const p = words.length === 1 ? words[0].slice(0, 4) : words.map(w => w[0]).join('').slice(0, 4);
  return (p.length >= 2 ? p : (p + 'JOB')).slice(0, 4) || 'JOB';
}

export async function companyPrefix(companyId: string) {
  const c = await db.companies.get({ id: companyId });
  const p = j<any>(c?.settings, {}).jobCodePrefix;
  return PREFIX_RE.test(p || '') ? p : derivePrefix(c?.name || '');
}

export const formatJobCode = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

/** Atomically reserves the next number for the company and returns the formatted job ID. */
export async function nextJobCode(companyId: string) {
  const prefix = await companyPrefix(companyId);
  const doc: any = await raw.collection('companies').findOneAndUpdate({ _id: companyId as any }, { $inc: { job_seq: 1 } }, { returnDocument: 'after' });
  const n = (doc?.value ?? doc)?.job_seq ?? 1;
  return formatJobCode(prefix, n);
}

/** True if the text looks like a job ID (PREFIX-123), so searches can match it exactly. */
export const looksLikeJobCode = (q: string) => /^[A-Za-z0-9]{2,8}-\d{1,6}$/.test(q.trim());
