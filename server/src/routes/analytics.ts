import { Router } from 'express';
import { db, j } from '../db.js';
import { requirePerm, tenant } from '../auth.js';
import { wrap } from '../util.js';
import { audit, usageSummary } from '../services.js';

export const analyticsRouter = Router();

/** Job-level filters (the old SQL applied these to the joined `jobs` row). */
function jobFilter(cid: string, q: Record<string, any>) {
  const f: Record<string, any> = { company_id: cid };
  if (q.jobId) f.id = String(q.jobId);
  if (q.department) f.department = String(q.department);
  if (q.recruiterId) f.recruiter_id = String(q.recruiterId);
  return f;
}
const uniq = <T,>(a: T[]) => [...new Set(a)];

analyticsRouter.get('/analytics', requirePerm('analytics.view'), wrap(async (req, res) => {
  const cid = tenant(req); const q = req.query as Record<string, any>;
  const from = q.from || '1970-01-01', to = q.to || '2999-01-01';
  const jf = jobFilter(cid, q);
  const hasJobFilter = !!(q.jobId || q.department || q.recruiterId);

  const totalJobs = await db.jobs.count({ ...jf, is_template: 0 });
  const activeJobs = await db.jobs.count({ ...jf, is_template: 0, status: 'published' });
  // jobs that satisfy the filters (templates included, as in the old joins); applications/interviews must belong to one of them
  const jobIds = new Set<string>((await db.jobs.list(jf, { projection: { id: 1 } })).map(x => x.id));

  const apps = await db.applications.list({ company_id: cid, created_at: { $gte: from, $lte: to } }, { projection: { candidate_id: 1, stage: 1, job_id: 1 } });
  const appsF = apps.filter(a => jobIds.has(a.job_id));
  const candidates = new Set(appsF.map(a => a.candidate_id)).size;
  const stages: Record<string, number> = {};
  for (const a of appsF) stages[a.stage] = (stages[a.stage] || 0) + 1;

  // interviews in the period (company-scoped), joined to their application's job
  const ivRange = await db.interviews.list({ company_id: cid, scheduled_at: { $gte: from, $lte: to } }, { projection: { application_id: 1, status: 1, scheduled_at: 1, started_at: 1, ended_at: 1 } });
  const jobOfApp = new Map<string, string>();
  const loadApps = async (ids: string[]) => {
    const need = uniq(ids).filter(id => !jobOfApp.has(id));
    if (need.length) for (const a of await db.applications.list({ company_id: cid, id: { $in: need } }, { projection: { job_id: 1 } })) jobOfApp.set(a.id, a.job_id);
  };
  await loadApps(ivRange.map(i => i.application_id));
  const ivAll = ivRange.filter(i => jobIds.has(jobOfApp.get(i.application_id) as string));

  let ivBase = ivAll;
  if (q.interviewerId) {
    const ps = await db.interview_participants.list({ company_id: cid, user_id: String(q.interviewerId), interview_id: { $in: ivAll.map(i => i.id) } }, { projection: { interview_id: 1 } });
    const ok = new Set(ps.map(p => p.interview_id));
    ivBase = ivBase.filter(i => ok.has(i.id));
  }
  if (q.status) ivBase = ivBase.filter(i => i.status === String(q.status));
  const nowIso = new Date().toISOString();
  const upcoming = ivBase.filter(i => i.status === 'scheduled' && i.scheduled_at >= nowIso).length;
  const completedIv = ivBase.filter(i => i.status === 'completed');
  const completed = completedIv.length;
  const durs = completedIv.filter(i => i.started_at && i.ended_at).map(i => (new Date(i.ended_at).getTime() - new Date(i.started_at).getTime()) / 60000).filter(n => !Number.isNaN(n));
  const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;

  // pending evaluations: participants of completed interviews (any date) with no submitted feedback
  const doneIvs = await db.interviews.list({ company_id: cid, status: 'completed' }, { projection: { application_id: 1 } });
  await loadApps(doneIvs.map(i => i.application_id));
  const doneIds = doneIvs.filter(i => jobIds.has(jobOfApp.get(i.application_id) as string)).map(i => i.id);
  let pendingEval = 0;
  if (doneIds.length) {
    const parts = await db.interview_participants.list({ company_id: cid, interview_id: { $in: doneIds } }, { projection: { interview_id: 1, user_id: 1 } });
    const fb = new Set((await db.interview_feedback.list({ company_id: cid, interview_id: { $in: doneIds }, submitted: 1 }, { projection: { interview_id: 1, interviewer_id: 1 } })).map(f => `${f.interview_id}:${f.interviewer_id}`));
    pendingEval = parts.filter(p => !fb.has(`${p.interview_id}:${p.user_id}`)).length;
  }

  // interviews per interviewer (period + job filters only)
  const statusOf = new Map(ivAll.map(i => [i.id, i.status]));
  const perUser = new Map<string, { interviews: number; completed: number }>();
  if (ivAll.length) {
    for (const p of await db.interview_participants.list({ company_id: cid, interview_id: { $in: ivAll.map(i => i.id) } }, { projection: { interview_id: 1, user_id: 1 } })) {
      const e = perUser.get(p.user_id) ?? { interviews: 0, completed: 0 };
      e.interviews++; if (statusOf.get(p.interview_id) === 'completed') e.completed++;
      perUser.set(p.user_id, e);
    }
  }
  const users = perUser.size ? await db.users.list({ id: { $in: [...perUser.keys()] } }, { projection: { name: 1 } }) : [];
  const byInterviewer = users.map(u => ({ name: u.name, ...perUser.get(u.id)! })).sort((a, b) => b.interviews - a.interviews).slice(0, 20);

  // coding submissions (graded) joined to interview -> application -> job
  const subsAll = await db.coding_submissions.list({ company_id: cid, kind: 'submit', created_at: { $gte: from, $lte: to } }, { projection: { interview_id: 1, score: 1, passed: 1, total: 1 } });
  let subs: any[] = [];
  if (subsAll.length) {
    const ivs = await db.interviews.list({ company_id: cid, id: { $in: uniq(subsAll.map(s => s.interview_id)) } }, { projection: { application_id: 1 } });
    await loadApps(ivs.map(i => i.application_id));
    const okIv = new Set(ivs.filter(i => jobIds.has(jobOfApp.get(i.application_id) as string)).map(i => i.id));
    subs = subsAll.filter(s => okIv.has(s.interview_id));
  }
  const scored = subs.filter(s => s.score != null);
  const coding = {
    submissions: subs.length,
    avg_score: scored.length ? Math.round((scored.reduce((a, s) => a + s.score, 0) / scored.length) * 10) / 10 : null,
    full_pass: subs.length ? subs.filter(s => s.passed === s.total && s.total > 0).length : null,
  };
  void hasJobFilter;
  const departments = (await db.jobs.distinct('department', { company_id: cid, department: { $ne: null } })) as string[];
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
    usage: await usageSummary(cid),
  });
}));

const csvCell = (v: any) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // also blocks CSV/formula injection

analyticsRouter.get('/reports/export', requirePerm('reports.export'), wrap(async (req, res) => {
  const cid = tenant(req); const type = String(req.query.type || 'candidates');
  let rows: any[] = [];
  if (type === 'interviews') {
    const ivs = await db.interviews.list({ company_id: cid }, { sort: { scheduled_at: -1 } });
    const apps = await db.applications.list({ company_id: cid, id: { $in: uniq(ivs.map(i => i.application_id)) } }, { projection: { candidate_id: 1, job_id: 1 } });
    const appBy = new Map(apps.map(a => [a.id, a]));
    const cands = await db.candidates.list({ company_id: cid, id: { $in: uniq(apps.map(a => a.candidate_id)) } }, { projection: { name: 1 } });
    const jobs = await db.jobs.list({ company_id: cid, id: { $in: uniq(apps.map(a => a.job_id)) } }, { projection: { title: 1 } });
    const cBy = new Map(cands.map(c => [c.id, c])); const jBy = new Map(jobs.map(x => [x.id, x]));
    for (const i of ivs) {
      const a = appBy.get(i.application_id); const c = a && cBy.get(a.candidate_id); const jb = a && jBy.get(a.job_id);
      if (!a || !c || !jb) continue;
      rows.push({ title: i.title, candidate: c.name, job: jb.title, round_no: i.round_no, type: i.type, scheduled_at: i.scheduled_at, duration_min: i.duration_min, status: i.status });
    }
  } else {
    const apps = await db.applications.list({ company_id: cid }, { sort: { created_at: -1 } });
    const cands = await db.candidates.list({ company_id: cid, id: { $in: uniq(apps.map(a => a.candidate_id)) } }, { projection: { name: 1, email: 1 } });
    const jobs = await db.jobs.list({ company_id: cid, id: { $in: uniq(apps.map(a => a.job_id)) } }, { projection: { title: 1 } });
    const cBy = new Map(cands.map(c => [c.id, c])); const jBy = new Map(jobs.map(x => [x.id, x]));
    for (const a of apps) {
      const c = cBy.get(a.candidate_id); const jb = jBy.get(a.job_id);
      if (!c || !jb) continue;
      rows.push({ name: c.name, email: c.email ?? null, job: jb.title, stage: a.stage, decision: a.decision ?? null, match_score: a.match_score ?? null, created_at: a.created_at });
    }
  }
  await audit(cid, req.auth!, 'report.exported', type, req);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
  res.send(csv);
}));

analyticsRouter.get('/dashboard/upcoming', wrap(async (req, res) => {
  const cid = tenant(req);
  const parts = await db.interview_participants.list({ company_id: cid, user_id: req.auth!.userId }, { projection: { interview_id: 1 } });
  const ivs = parts.length ? await db.interviews.list({
    company_id: cid, id: { $in: parts.map(p => p.interview_id) }, status: { $in: ['scheduled', 'in_progress'] }, scheduled_at: { $gte: new Date(Date.now() - 3 * 3600e3).toISOString() },
  }, { sort: { scheduled_at: 1 }, limit: 8, projection: { title: 1, scheduled_at: 1, status: 1, application_id: 1 } }) : [];
  const apps = ivs.length ? await db.applications.list({ company_id: cid, id: { $in: uniq(ivs.map(i => i.application_id)) } }, { projection: { candidate_id: 1 } }) : [];
  const cands = apps.length ? await db.candidates.list({ company_id: cid, id: { $in: uniq(apps.map(a => a.candidate_id)) } }, { projection: { name: 1 } }) : [];
  const appBy = new Map(apps.map(a => [a.id, a])); const cBy = new Map(cands.map(c => [c.id, c]));
  const rows = ivs.filter(i => cBy.has(appBy.get(i.application_id)?.candidate_id)).map(i => ({ id: i.id, title: i.title, scheduled_at: i.scheduled_at, status: i.status, candidate_name: cBy.get(appBy.get(i.application_id).candidate_id).name }));
  res.json({ items: rows });
}));
export { j };
