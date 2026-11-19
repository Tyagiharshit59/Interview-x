import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { db, j } from './db.js';
import { config } from './config.js';
import { HttpError, forbidden } from './util.js';
import { audit } from './services.js';

export type Role = 'owner' | 'admin' | 'recruiter' | 'interviewer' | 'hiring_manager';
export const ROLES: Role[] = ['owner', 'admin', 'recruiter', 'interviewer', 'hiring_manager'];

const ALL: Role[] = ['owner', 'admin', 'recruiter', 'interviewer', 'hiring_manager'];
export const PERMS = {
  'company.manage': ['owner', 'admin'],
  'billing.manage': ['owner', 'admin'],
  'members.manage': ['owner', 'admin'],
  'jobs.read': ALL,
  'jobs.write': ['owner', 'admin', 'recruiter'],
  'candidates.read': ALL,
  'candidates.write': ['owner', 'admin', 'recruiter'],
  'interviews.read': ALL,
  'interviews.schedule': ['owner', 'admin', 'recruiter'],
  'interviews.conduct': ['owner', 'admin', 'interviewer', 'hiring_manager'],
  'recordings.view': ['owner', 'admin', 'hiring_manager', 'interviewer'],
  'recordings.delete': ['owner', 'admin'],
  'feedback.submit': ['owner', 'admin', 'interviewer', 'hiring_manager'],
  'feedback.viewAll': ['owner', 'admin', 'hiring_manager', 'recruiter'],
  'decision.make': ['owner', 'admin', 'hiring_manager'],
  'questions.write': ['owner', 'admin', 'recruiter', 'interviewer'],
  'analytics.view': ['owner', 'admin', 'recruiter', 'hiring_manager'],
  'reports.export': ['owner', 'admin', 'hiring_manager'],
  'ai.use': ALL,
  'audit.view': ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;
export type Perm = keyof typeof PERMS;
export const can = (role: Role | undefined, perm: Perm) => !!role && (PERMS[perm] as readonly Role[]).includes(role);

export interface Auth {
  userId: string; email: string; name: string; isSuperAdmin: boolean;
  companyId: string | null; role: Role | null; supportMode: boolean; mfaEnabled: boolean; emailVerified: boolean;
}
declare module 'express-serve-static-core' { interface Request { auth?: Auth } }

export const COOKIE = 'ivx_session';
export function issueSession(res: Response, user: { id: string; session_version: number }, companyId: string | null, support = false) {
  const token = jwt.sign({ sub: user.id, sv: user.session_version, cid: companyId, sup: support ? 1 : 0 }, config.jwtSecret, { expiresIn: support ? '1h' : '12h' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: (support ? 1 : 12) * 3600 * 1000, path: '/',
  });
}

export function authFromToken(token: string | undefined): Auth | null {
  if (!token) return null;
  let p: any;
  try { p = jwt.verify(token, config.jwtSecret); } catch { return null; }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.sub) as any;
  if (!u || u.session_version !== p.sv) return null;
  let role: Role | null = null;
  let cid: string | null = p.cid || null;
  if (cid) {
    if (u.is_super_admin && p.sup) {
      const c = db.prepare('SELECT status FROM companies WHERE id=?').get(cid) as any;
      if (!c) return null;
      role = 'admin';
    } else {
      const m = db.prepare(`SELECT m.role, c.status FROM company_members m JOIN companies c ON c.id=m.company_id
        WHERE m.company_id=? AND m.user_id=? AND m.status='active'`).get(cid, u.id) as any;
      if (!m) { cid = null; }
      else if (m.status !== 'active') return null;
      else role = m.role;
    }
  }
  return {
    userId: u.id, email: u.email, name: u.name, isSuperAdmin: !!u.is_super_admin, companyId: cid, role,
    supportMode: !!p.sup, mfaEnabled: !!u.mfa_enabled, emailVerified: !!u.email_verified,
  };
}

export function parseCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const a = authFromToken(req.cookies?.[COOKIE]);
  if (!a) return next(new HttpError(401, 'Please sign in', 'unauthenticated'));
  req.auth = a;
  if (a.supportMode) {
    if (req.method !== 'GET') return next(forbidden('Support sessions are read-only', 'support_readonly'));
    audit(a.companyId, a, 'support.read', `${req.method} ${req.originalUrl}`, req);
  }
  next();
}

/** Requires an authenticated user with an active company membership. Tenant id always comes from the session, never from the client. */
export function requireTenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth?.companyId || !req.auth.role) return next(new HttpError(403, 'No active company selected', 'no_company'));
  const c = db.prepare('SELECT status FROM companies WHERE id=?').get(req.auth.companyId) as any;
  if (!c || c.status !== 'active') return next(new HttpError(403, 'This company account is suspended', 'suspended'));
  next();
}

export const requirePerm = (perm: Perm) => (req: Request, _res: Response, next: NextFunction) => {
  if (!can(req.auth?.role ?? undefined, perm)) return next(forbidden());
  next();
};

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth?.isSuperAdmin || req.auth.supportMode) return next(forbidden('Super admin only'));
  next();
}

export const tenant = (req: Request) => req.auth!.companyId!;
export { j };
