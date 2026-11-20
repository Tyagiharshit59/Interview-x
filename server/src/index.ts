import { subscriptionNotices } from './extras.js';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { db, now, closeDb } from './db.js';
import { ensureSeed } from './seed.js';
import { HttpError } from './util.js';
import { requireAuth, requireTenant } from './auth.js';
import { authRouter } from './routes/auth.js';
import { companyRouter } from './routes/company.js';
import { recruitRouter, filesRouter } from './routes/recruitment.js';
import { interviewRouter } from './routes/interviews.js';
import { publicRouter, mediaRouter, purgeExpiredRecordings } from './routes/public.js';
import { codingRouter } from './routes/coding.js';
import { evalRouter } from './routes/evaluation.js';
import { analyticsRouter } from './routes/analytics.js';
import { billingRouter, webhookRouter } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { portalRouter, candidateUpdatesRouter } from './routes/portal.js';
import { referralRouter } from './routes/referrals.js';
import { requireAuth as ra } from './auth.js';
import { attachRealtime } from './realtime.js';
import { sendMail, notify } from './services.js';

await ensureSeed();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: config.isProd ? {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'], styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'", 'ws:', 'wss:', 'https://cdn.jsdelivr.net'], workerSrc: ["'self'", 'blob:'], fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());

// Webhooks need the raw body: mount BEFORE json parser.
app.use('/api/webhooks', webhookRouter);
app.use(express.json({ limit: '1mb' }));

// CSRF defence for cookie auth: state-changing requests must be JSON/multipart/octet-stream from our own origin.
app.use('/api', (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/webhooks')) return next();
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host && !(config.isProd === false && /localhost:5173$/.test(origin))) return next(new HttpError(403, 'Cross-origin request blocked', 'csrf'));
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: now() }));
app.use('/api/auth', authRouter);
app.use('/api/public', publicRouter);
app.use('/api/portal', portalRouter);
app.use('/api/files', filesRouter);
app.use('/api/admin', requireAuth, adminRouter);

const tenantApi = express.Router();
tenantApi.use(requireAuth, requireTenant);
// Default-deny for the referral-only `employee` role: it may use the referral portal and its own notifications, nothing else.
const EMPLOYEE_ALLOWED = [/^\/referrals(\/|$)/, /^\/notifications(\/|$)/, /^\/notification-prefs$/, /^\/announcements$/, /^\/support$/];
tenantApi.use((req, _res, next) => (req.auth?.role === 'employee' && !EMPLOYEE_ALLOWED.some(r => r.test(req.path)) ? next(new HttpError(403, 'Your account can only use the referral portal.', 'employee_only')) : next()));
tenantApi.use(companyRouter, recruitRouter, interviewRouter, codingRouter, evalRouter, analyticsRouter, billingRouter, candidateUpdatesRouter, referralRouter);
app.use('/api', mediaRouter);
app.use('/api', tenantApi);
void ra;

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// Serve built frontend in production
const dist = path.resolve(process.cwd(), '../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.extra });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (max 8 MB)', code: 'too_large' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large', code: 'too_large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON', code: 'bad_json' });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'internal' });
});

const server = http.createServer(app);
attachRealtime(server);

/* Background jobs: reminders, trial/renewal notices, retention purge. */
let jobsRunning = false;
async function backgroundJobs() {
  if (jobsRunning) return; jobsRunning = true; // never overlap runs
  try {
    const purged = await purgeExpiredRecordings(); if (purged) console.log(`[jobs] purged ${purged} expired recording(s)`);
    // 24h and 1h reminders (once each, tracked via audit_logs)
    const soon = await db.interviews.list({ status: 'scheduled', scheduled_at: { $gt: now(), $lt: new Date(Date.now() + 24 * 3600e3).toISOString() } });
    for (const i of soon) {
      const hrs = (new Date(i.scheduled_at).getTime() - Date.now()) / 3600e3;
      const tag = hrs <= 1.2 ? 'reminder_1h' : hrs <= 24 ? 'reminder_24h' : null;
      if (!tag) continue;
      if (await db.audit_logs.exists({ action: tag, target: i.id })) continue;
      await db.audit_logs.insert({ company_id: i.company_id, action: tag, target: i.id, created_at: now() });
      const parts = await db.interview_participants.list({ interview_id: i.id });
      const prefs = new Map((await db.notification_prefs.list({ user_id: { $in: parts.map(p => p.user_id) } })).map(n => [n.user_id, n]));
      for (const p of parts) {
        const n = prefs.get(p.user_id);
        if (n && n.reminders != null && n.reminders !== 1) continue;
        await notify(i.company_id, p.user_id, 'reminder', `Upcoming interview: ${i.title}`, `Starts ${new Date(i.scheduled_at).toUTCString()}`, `/interviews/${i.id}`, { email: tag === 'reminder_1h' });
      }
      if (tag === 'reminder_24h') {
        const app = await db.applications.get({ id: i.application_id, company_id: i.company_id });
        const cand = app ? await db.candidates.get({ id: app.candidate_id, company_id: i.company_id }) : null;
        if (cand?.email) void sendMail(i.company_id, cand.email, `Reminder: your interview "${i.title}" is tomorrow`, 'Use the personal link from your invitation email to join. The room opens 30 minutes before the start time.');
      }
    }
    // trial ending in <=3 days
    for (const s of await db.subscriptions.list({ status: 'trialing', trial_ends_at: { $gt: now(), $lt: new Date(Date.now() + 3 * 864e5).toISOString() } })) {
      if (await db.audit_logs.exists({ action: 'trial_notice', target: s.company_id })) continue;
      await db.audit_logs.insert({ company_id: s.company_id, action: 'trial_notice', target: s.company_id, created_at: now() });
      for (const m of await db.company_members.list({ company_id: s.company_id, role: { $in: ['owner', 'admin'] } }))
        await notify(s.company_id, m.user_id, 'billing', 'Your free trial ends soon', `Trial ends ${new Date(s.trial_ends_at).toDateString()}. Choose a plan to keep access.`, '/billing', { email: true });
    }
    await subscriptionNotices();
  } catch (e) { console.error('[jobs]', e); }
  finally { jobsRunning = false; }
}
setInterval(() => void backgroundJobs(), 10 * 60_000).unref();
setTimeout(() => void backgroundJobs(), 5000).unref();

server.listen(config.port, () => console.log(`IntervueX API listening on http://localhost:${config.port}  (runner: ${config.runner.mode})`));

// Graceful shutdown: stop accepting connections, then close MongoDB (and the embedded dev mongod, if any).
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => {
  server.close(); closeDb().catch(() => {}).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
