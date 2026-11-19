import { Router } from 'express';
import { db, j } from '../db.js';
import { requirePerm, tenant } from '../auth.js';
import { wrap } from '../util.js';
import { audit, usageSummary } from '../services.js';

export const analyticsRouter = Router();

function filters(q: Record<string, any>) {
  const w: string[] = []; const a: any[] = [];
  if (q.jobId) { w.push('jb.id=?'); a.push(q.jobId); }
  if (q.department) { w.push('jb.department=?'); a.push(q.department); }
  if (q.recruiterId) { w.push('jb.recruiter_id=?'); a.push(q.recruiterId); }
  return { w, a };
}

analyticsRouter.get('/analytics', requirePerm('analytics.view'), wrap((req, res) => {
  const cid = tenant(req); const q = req.query as Record<string, any>;
  const from = q.from || '1970-01-01', to = q.to || '2999-01-01';
  const f = filters(q);
  const jw = f.w.length ? ' AND ' + f.w.join(' AND ') : '';
  const one = (sql: string, ...args: any[]) => (db.prepare(sql).get(...args) as any).c as number;

  const totalJobs = one(`SELECT COUNT(*) c FROM jobs jb WHERE jb.company_id=? AND jb.is_template=0${jw}`, cid, ...f.a);
  const activeJobs = one(`SELECT COUNT(*) c FROM jobs jb WHERE jb.company_id=? AND jb.is_template=0 AND jb.status='published'${jw}`, cid, ...f.a);
  const candidates = one(`SELECT COUNT(DISTINCT a.candidate_id) c FROM applications a JOIN jobs jb ON jb.id=a.job_id WHERE a.company_id=? AND a.created_at>=? AND a.created_at<=?${jw}`, cid, from, to, ...f.a);
  const stageRows = db.prepare(`SELECT a.stage, COUNT(*) n FROM applications a JOIN jobs jb ON jb.id=a.job_id WHERE a.company_id=? AND a.created_at>=? AND a.created_at<=?${jw} GROUP BY a.stage`).all(cid, from, to, ...f.a) as any[];
  const stages = Object.fromEntries(stageRows.map(r => [r.stage, r.n]));

  let iw = ''; const ia: any[] = [];
  if (q.interviewerId) { iw += ' AND EXISTS (SELECT 1 FROM interview_participants p WHERE p.interview_id=i.id AND p.user_id=?)'; ia.push(q.interviewerId); }
  if (q.status) { iw += ' AND i.status=?'; ia.push(q.status); }
  const base = `FROM interviews i JOIN applications a ON a.id=i.application_id JOIN jobs jb ON jb.id=a.job_id WHERE i.company_id=? AND i.scheduled_at>=? AND i.scheduled_at<=?${jw}${iw}`;
  const bargs = [cid, from, to, ...f.a, ...ia];
  const upcoming = one(`SELECT COUNT(*) c ${base} AND i.status='scheduled' AND i.scheduled_at>=?`, ...bargs, new Date().toISOString());
  const completed = one(`SELECT COUNT(*) c ${base} AND i.status='completed'`, ...bargs);
  const avgDur = (db.prepare(`SELECT AVG((julianday(i.ended_at)-julianday(i.started_at))*1440) m ${base} AND i.status='completed' AND i.started_at IS NOT NULL AND i.ended_at IS NOT NULL`).get(...bargs) as any).m;
  const pendingEval = one(`SELECT COUNT(*) c FROM interview_participants p JOIN interviews i ON i.id=p.interview_id JOIN applications a ON a.id=i.application_id JOIN jobs jb ON jb.id=a.job_id
    WHERE i.company_id=? AND i.status='completed' AND NOT EXISTS (SELECT 1 FROM interview_feedback f WHERE f.interview_id=i.id AND f.interviewer_id=p.user_id AND f.submitted=1)${jw}`, cid, ...f.a);
  const byInterviewer = db.prepare(`SELECT u.name, COUNT(*) interviews, SUM(CASE WHEN i.status='completed' THEN 1 ELSE 0 END) completed
    FROM interview_participants p JOIN interviews i ON i.id=p.interview_id JOIN users u ON u.id=p.user_id JOIN applications a ON a.id=i.application_id JOIN jobs jb ON jb.id=a.job_id
    WHERE i.company_id=? AND i.scheduled_at>=? AND i.scheduled_at<=?${jw} GROUP BY u.id ORDER BY interviews DESC LIMIT 20`).all(cid, from, to, ...f.a);
  const coding = db.prepare(`SELECT COUNT(*) submissions, ROUND(AVG(s.score),1) avg_score, SUM(CASE WHEN s.passed=s.total AND s.total>0 THEN 1 ELSE 0 END) full_pass
    FROM coding_submissions s JOIN interviews i ON i.id=s.interview_id JOIN applications a ON a.id=i.application_id JOIN jobs jb ON jb.id=a.job_id
    WHERE s.company_id=? AND s.kind='submit' AND s.created_at>=? AND s.created_at<=?${jw}`).get(cid, from, to, ...f.a) as any;
  const departments = (db.prepare('SELECT DISTINCT department d FROM jobs WHERE company_id=? AND department IS NOT NULL').all(cid) as any[]).map(r => r.d);
  const funnel = ['Applied', 'Screening', 'Shortlisted', 'Interview Scheduled', 'Interview Completed', 'Evaluation', 'Selected'].map(s => ({ stage: s, count: stages[s] || 0 }));

  res.json({
    metrics: {
      totalJobs: { value: totalJobs, help: 'Jobs created (excluding templates) that match the filters.' },
      activeJobs: { value: activeJobs, help: 'Jobs currently published.' },
      totalCandidates: { value: candidates, help: 'Unique candidates with an application created in the selected period.' },
      upcomingInterviews: { value: upcoming, help: 'Scheduled interviews that have not started yet.' },
      completedInterviews: { value: completed, help: 'Interviews that were ended by an interviewer.' },
      shortlisted: { value: stages['Shortlisted'] || 0, help: 'Applications currently in the Shortlisted stage.' },
      selected: { value: stages['Selected'] || 0, help: 'Applications with a human "Selected" decision.' },
      rejected: { value: stages['Rejected'] || 0, help: 'Applications with a human "Rejected" decision.' },
      pendingEvaluations: { value: pendingEval, help: 'Interviewer feedback forms still waiting for submission on completed interviews.' },
      avgDurationMin: { value: avgDur ? Math.round(avgDur) : 0, help: 'Average minutes between start and end of completed interviews. Interviews that were never started are excluded.' },
    },
    funnel, byInterviewer, coding: { ...coding, help: 'Graded code submissions. Average score is the share of weighted test cases passed.' }, departments,
    usage: usageSummary(cid),
  });
}));

const csvCell = (v: any) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // also blocks CSV/formula injection

analyticsRouter.get('/reports/export', requirePerm('reports.export'), wrap((req, res) => {
  const cid = tenant(req); const type = String(req.query.type || 'candidates');
  let rows: any[] = [];
  if (type === 'interviews') {
    rows = db.prepare(`SELECT i.title, c.name candidate, jb.title job, i.round_no, i.type, i.scheduled_at, i.duration_min, i.status FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs jb ON jb.id=a.job_id WHERE i.company_id=? ORDER BY i.scheduled_at DESC`).all(cid) as any[];
  } else {
    rows = db.prepare(`SELECT c.name, c.email, jb.title job, a.stage, a.decision, a.match_score, a.created_at FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs jb ON jb.id=a.job_id WHERE a.company_id=? ORDER BY a.created_at DESC`).all(cid) as any[];
  }
  audit(cid, req.auth!, 'report.exported', type, req);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
  res.send(csv);
}));

analyticsRouter.get('/dashboard/upcoming', wrap((req, res) => {
  const rows = db.prepare(`SELECT i.id,i.title,i.scheduled_at,i.status,c.name candidate_name FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id
    JOIN interview_participants p ON p.interview_id=i.id WHERE i.company_id=? AND p.user_id=? AND i.status IN ('scheduled','in_progress') AND i.scheduled_at>=? ORDER BY i.scheduled_at LIMIT 8`).all(tenant(req), req.auth!.userId, new Date(Date.now() - 3 * 3600e3).toISOString());
  res.json({ items: rows });
}));
export { j };
