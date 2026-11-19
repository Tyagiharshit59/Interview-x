import crypto from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodError, type ZodTypeAny } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra?: any) { super(message); }
}
export const bad = (m: string, code?: string) => new HttpError(400, m, code);
export const forbidden = (m = 'You do not have permission to do this', code = 'forbidden') => new HttpError(403, m, code);
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => any): RequestHandler =>
  (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try { return schema.parse(data); }
  catch (e) {
    if (e instanceof ZodError) {
      throw new HttpError(422, 'Validation failed', 'validation', e.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
    }
    throw e;
  }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** 256-bit URL-safe random token. Only the sha256 is stored. */
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const addMinutes = (m: number, from = new Date()) => new Date(from.getTime() + m * 60000).toISOString();
export const addDays = (d: number, from = new Date()) => addMinutes(d * 1440, from);
export const isExpired = (iso: string | null | undefined) => !iso || new Date(iso).getTime() < Date.now();

export function timingSafeEq(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ---------- TOTP (RFC 6238) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function base32Decode(s: string) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totpAt(secret: string, counter: number) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string, window = 1) {
  const c = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) if (timingSafeEq(totpAt(secret, c + w), code.trim())) return true;
  return false;
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';

export const clientIp = (req: Request) => (req.ip || req.socket.remoteAddress || '').replace('::ffff:', '');

export const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
