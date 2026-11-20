import { Link } from 'react-router-dom';
import { Briefcase, Users, CalendarClock, MessageSquareWarning, Check, ArrowRight, Video, Plus, CalendarX } from 'lucide-react';
import type { ReactNode } from 'react';
import { get, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Card, Empty, ErrorBox, Loading, Meter, PageHeader, statusBadge, useLoad } from '../ui';

function Stat({ label, value, icon, tone }: { label: string; value: ReactNode; icon: ReactNode; tone: string }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-soft transition duration-300 hover:-translate-y-0.5 hover:shadow-lift animate-fade-up">
      <div className={`pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-20 blur-2xl ${tone}`} />
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[13px] font-semibold text-muted">{label}</div>
          <div className="mt-2 text-[2.1rem] font-extrabold leading-none tracking-tight">{value}</div>
        </div>
        <span className={`grid h-11 w-11 place-items-center rounded-xl text-white shadow-sm ${tone}`}>{icon}</span>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { me, can } = useAuth();
  const { data: jobs } = useLoad(() => get('/jobs'));
  const { data: cands } = useLoad(() => get('/candidates'));
  const { data: up, loading, error } = useLoad(() => get('/dashboard/upcoming'));
  const { data: usage } = useLoad(() => get('/usage'));
  const { data: ints } = useLoad(() => get('/interviews'));
  if (loading) return <Loading />;
  const steps = [
    { done: (jobs?.items.length || 0) > 0, label: 'Create your first job', hint: 'Upload a JD or start from a template', to: '/jobs/new' },
    { done: (cands?.items.length || 0) > 0, label: 'Add a candidate', hint: 'Upload a CV and we parse the details', to: '/candidates' },
    { done: (ints?.items.length || 0) > 0, label: 'Schedule your first interview', hint: 'Invite the candidate with a secure link', to: '/interviews/new' },
  ];
  const doneCount = steps.filter(s => s.done).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const ic = 'h-5 w-5';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        title={<>{greet}, <span className="bg-brand-gradient bg-clip-text text-transparent">{me?.user.name.split(' ')[0]}</span></>}
        description="Here's what's happening across your hiring today."
        actions={can('interviews.schedule') && <Link className="btn primary" to="/interviews/new"><Plus className="h-4 w-4" />Schedule interview</Link>}
      />
      <ErrorBox error={error} />

      {doneCount < steps.length && (
        <div className="relative overflow-hidden rounded-2xl bg-night-gradient p-6 text-white shadow-lift sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-brand-500/30 blur-3xl" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center">
            <div className="lg:w-72">
              <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-300">Getting started</div>
              <h2 className="mt-2 text-xl text-white">Set up your hiring workspace</h2>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gold-gradient transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
              <div className="mt-2 text-[13px] text-slate-400">{doneCount} of {steps.length} complete</div>
            </div>
            <div className="grid flex-1 gap-3 sm:grid-cols-3">
              {steps.map((s, i) => (
                <Link key={i} to={s.to} className={`group rounded-xl border p-4 no-underline transition ${s.done ? 'border-white/5 bg-white/[0.03]' : 'border-white/10 bg-white/[0.06] hover:border-gold-400/40 hover:bg-white/[0.09]'}`}>
                  <span className={`grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold ${s.done ? 'bg-emerald-400/20 text-emerald-300' : 'bg-gold-gradient text-midnight-950'}`}>{s.done ? <Check className="h-4 w-4" /> : i + 1}</span>
                  <div className={`mt-3 text-[14px] font-semibold ${s.done ? 'text-slate-500 line-through' : 'text-white'}`}>{s.label}</div>
                  <div className="mt-1 flex items-center gap-1 text-[12.5px] text-slate-400">{s.hint}{!s.done && <ArrowRight className="h-3.5 w-3.5 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />}</div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active jobs" value={jobs?.items.filter((j: any) => j.status === 'published').length ?? '–'} icon={<Briefcase className={ic} />} tone="bg-brand-gradient" />
        <Stat label="Candidates" value={cands?.items.length ?? '–'} icon={<Users className={ic} />} tone="bg-gradient-to-br from-sky-500 to-indigo-500" />
        <Stat label="Upcoming interviews" value={ints?.items.filter((i: any) => i.status === 'scheduled').length ?? '–'} icon={<CalendarClock className={ic} />} tone="bg-gradient-to-br from-emerald-500 to-teal-500" />
        <Stat label="Awaiting feedback" value={ints?.items.filter((i: any) => i.status === 'completed' && i.feedback_count === 0).length ?? '–'} icon={<MessageSquareWarning className={ic} />} tone="bg-gold-gradient" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Your upcoming interviews" actions={<Link className="btn sm ghost" to="/interviews">View all <ArrowRight className="h-3.5 w-3.5" /></Link>}>
          {up?.items.length ? (
            <ul className="-mx-2 flex list-none flex-col p-0">
              {up.items.map((i: any) => {
                const d = new Date(i.scheduled_at);
                return (
                  <li key={i.id} className="flex flex-wrap items-center gap-4 rounded-xl px-2 py-3 transition hover:bg-raised/70">
                    <div className="grid w-14 flex-none place-items-center rounded-xl border border-line bg-raised/60 py-1.5 text-center">
                      <div className="text-[10.5px] font-bold uppercase tracking-wider text-brand-500">{d.toLocaleDateString(undefined, { month: 'short' })}</div>
                      <div className="text-lg font-extrabold leading-tight">{d.getDate()}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link to={`/interviews/${i.id}`} className="block truncate text-[15px] font-semibold text-ink hover:text-brand-600">{i.title}</Link>
                      <div className="truncate text-[13px] text-muted">{i.candidate_name} · {fmtDate(i.scheduled_at)}</div>
                    </div>
                    {statusBadge(i.status)}
                    <Link className="btn sm primary" to={`/interviews/${i.id}/room`}><Video className="h-3.5 w-3.5" />Join</Link>
                  </li>
                );
              })}
            </ul>
          ) : <Empty title="No interviews on your calendar" icon={<CalendarX className="h-6 w-6" />}>When you're added to an interview it will appear here.</Empty>}
        </Card>

        <Card title="Plan usage" actions={can('billing.manage') && <Link className="btn sm ghost" to="/billing">Manage <ArrowRight className="h-3.5 w-3.5" /></Link>}>
          {usage && (
            <div className="flex flex-col gap-5">
              {([['Team accounts', usage.members], ['Interviews this month', usage.interviews], ['Code runs', usage.code_runs], ['AI requests', usage.ai_calls]] as const).map(([l, u]: any) => (
                <div key={l}><div className="mb-1.5 text-[13.5px] font-semibold">{l}</div><Meter used={u.used} limit={u.limit} /></div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
