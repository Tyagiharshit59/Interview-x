import { subscriptionNotices } from './extras.js';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { db, now } from './db.js';
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
import { requireAuth as ra } from './auth.js';
import { attachRealtime } from './realtime.js';
import { sendMail, notify } from './services.js';

ensureSeed();

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
app.use('/api/files', filesRouter);
app.use('/api/admin', requireAuth, adminRouter);

const tenantApi = express.Router();
tenantApi.use(requireAuth, requireTenant);
tenantApi.use(companyRouter, recruitRouter, interviewRouter, codingRouter, evalRouter, analyticsRouter, billingRouter);
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
function backgroundJobs() {
  try {
    const purged = purgeExpiredRecordings(); if (purged) console.log(`[jobs] purged ${purged} expired recording(s)`);
    // 24h and 1h reminders (once each, tracked via audit_logs)
    const soon = db.prepare(`SELECT i.*, c.email, c.name cname FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id
      WHERE i.status='scheduled' AND i.scheduled_at>? AND i.scheduled_at<?`).all(now(), new Date(Date.now() + 24 * 3600e3).toISOString()) as any[];
    for (const i of soon) {
      const hrs = (new Date(i.scheduled_at).getTime() - Date.now()) / 3600e3;
      const tag = hrs <= 1.2 ? 'reminder_1h' : hrs <= 24 ? 'reminder_24h' : null;
      if (!tag) continue;
      if (db.prepare('SELECT 1 FROM audit_logs WHERE action=? AND target=?').get(tag, i.id)) continue;
      db.prepare('INSERT INTO audit_logs(id,company_id,action,target,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), i.company_id, tag, i.id, now());
      for (const p of db.prepare('SELECT p.user_id FROM interview_participants p LEFT JOIN notification_prefs n ON n.user_id=p.user_id WHERE p.interview_id=? AND (n.reminders IS NULL OR n.reminders=1)').all(i.id) as any[])
        notify(i.company_id, p.user_id, 'reminder', `Upcoming interview: ${i.title}`, `Starts ${new Date(i.scheduled_at).toUTCString()}`, `/interviews/${i.id}`, { email: tag === 'reminder_1h' });
      if (tag === 'reminder_24h') void sendMail(i.company_id, i.email, `Reminder: your interview "${i.title}" is tomorrow`, 'Use the personal link from your invitation email to join. The room opens 30 minutes before the start time.');
    }
    // trial ending in <=3 days
    for (const s of db.prepare("SELECT company_id, trial_ends_at FROM subscriptions WHERE status='trialing' AND trial_ends_at>? AND trial_ends_at<?").all(now(), new Date(Date.now() + 3 * 864e5).toISOString()) as any[]) {
      if (db.prepare("SELECT 1 FROM audit_logs WHERE action='trial_notice' AND target=?").get(s.company_id)) continue;
      db.prepare("INSERT INTO audit_logs(id,company_id,action,target,created_at) VALUES (?,?,'trial_notice',?,?)").run(crypto.randomUUID(), s.company_id, s.company_id, now());
      for (const m of db.prepare("SELECT user_id FROM company_members WHERE company_id=? AND role IN ('owner','admin')").all(s.company_id) as any[])
        notify(s.company_id, m.user_id, 'billing', 'Your free trial ends soon', `Trial ends ${new Date(s.trial_ends_at).toDateString()}. Choose a plan to keep access.`, '/billing', { email: true });
    }
    subscriptionNotices();
  } catch (e) { console.error('[jobs]', e); }
}
import crypto from 'node:crypto';
setInterval(backgroundJobs, 10 * 60_000).unref();
setTimeout(backgroundJobs, 5000).unref();

server.listen(config.port, () => console.log(`IntervueX API listening on http://localhost:${config.port}  (runner: ${config.runner.mode})`));
