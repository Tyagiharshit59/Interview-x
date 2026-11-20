import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Loading } from './ui';
import { Layout } from './pages/Layout';
import { Home, PricingPage } from './pages/Public';
import { Login, Register, Forgot, ResetPassword, VerifyEmail, AcceptInvite, ActivateAccount } from './pages/AuthPages';
import { Dashboard } from './pages/Dashboard';
import { JobsList, JobEditor, JobDetail } from './pages/Jobs';
import { CandidatesList, CandidateProfile } from './pages/Candidates';
import { InterviewsList, ScheduleWizard, InterviewDetail } from './pages/Interviews';
import { Feedback } from './pages/Feedback';
import { Questions } from './pages/Questions';
import { Analytics } from './pages/Analytics';
import { Team } from './pages/Team';
import { Settings } from './pages/Settings';
import { Billing, InvoiceView } from './pages/Billing';
import { Join } from './pages/Join';
import { CameraCompanion } from './pages/Camera';
import { Playback } from './pages/Playback';
import { Admin } from './pages/Admin';
import { CompanyPage } from './pages/AdminConsole';
import { ReferHome, MyReferrals, ReferralsManage } from './pages/Referrals';
import { CandProvider, PortalLayout, RequireCand, PortalLogin, PortalRegister, PortalAccept, PortalVerify, PortalForgot, PortalReset } from './portal/Shell';
import { JobSearch, PortalJobDetail, SavedJobs } from './portal/Jobs';
import { CandDashboard, CandApplications, CandInterviews, CandJoin, CandProfile } from './portal/Account';
import { Outlet } from 'react-router-dom';

function Admin2() { const { me } = useAuth(); return me?.user.isSuperAdmin ? <CompanyPage /> : <Navigate to="/dashboard" replace />; }
const Cand = () => <CandProvider><Outlet /></CandProvider>;

const Room = lazy(() => import('./room/Room').then(m => ({ default: m.Room })));

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}
const needCompany = (el: ReactNode) => <Protected><CompanyOnly>{el}</CompanyOnly></Protected>;
function CompanyOnly({ children }: { children: ReactNode }) {
  const { me } = useAuth(); const loc = useLocation();
  if (me?.user.isSuperAdmin && !me.company) return <Navigate to="/admin" replace />;
  // referral-only employees: everything outside the referral portal sends them to it
  if (me?.role === 'employee' && !loc.pathname.startsWith('/referrals') || (me?.role === 'employee' && loc.pathname === '/referrals/manage')) return <Navigate to="/referrals" replace />;
  if (!me?.company) return <div className="auth-wrap"><div className="card auth-card"><h2>No company</h2><p>Your account is not part of an active company.</p></div></div>;
  return <>{children}</>;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<Forgot />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/activate" element={<ActivateAccount />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/join/:token" element={<Join />} />

        {/* Candidate careers portal (separate candidate accounts) */}
        <Route element={<Cand />}>
          <Route path="/portal/login" element={<PortalLogin />} />
          <Route path="/portal/register" element={<PortalRegister />} />
          <Route path="/portal/accept" element={<PortalAccept />} />
          <Route path="/portal/verify" element={<PortalVerify />} />
          <Route path="/portal/forgot-password" element={<PortalForgot />} />
          <Route path="/portal/reset-password" element={<PortalReset />} />
          <Route path="/portal/interviews/:id/join" element={<RequireCand><CandJoin /></RequireCand>} />
          <Route element={<PortalLayout />}>
            <Route path="/portal" element={<Navigate to="/portal/dashboard" replace />} />
            <Route path="/portal/jobs" element={<RequireCand><JobSearch /></RequireCand>} />
            <Route path="/portal/jobs/:id" element={<RequireCand><PortalJobDetail /></RequireCand>} />
            <Route path="/portal/dashboard" element={<RequireCand><CandDashboard /></RequireCand>} />
            <Route path="/portal/applications" element={<RequireCand><CandApplications /></RequireCand>} />
            <Route path="/portal/interviews" element={<RequireCand><CandInterviews /></RequireCand>} />
            <Route path="/portal/saved" element={<RequireCand><SavedJobs /></RequireCand>} />
            <Route path="/portal/profile" element={<RequireCand><CandProfile /></RequireCand>} />
          </Route>
        </Route>
        <Route path="/camera/:token" element={<CameraCompanion />} />

        <Route path="/interviews/:id/room" element={needCompany(<Room />)} />
        <Route element={<Protected><Layout /></Protected>}>
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/companies/:id" element={<Admin2 />} />
          <Route path="/dashboard" element={<CompanyOnly><Dashboard /></CompanyOnly>} />
          <Route path="/jobs" element={<CompanyOnly><JobsList /></CompanyOnly>} />
          <Route path="/jobs/new" element={<CompanyOnly><JobEditor /></CompanyOnly>} />
          <Route path="/jobs/:id/edit" element={<CompanyOnly><JobEditor /></CompanyOnly>} />
          <Route path="/jobs/:id" element={<CompanyOnly><JobDetail /></CompanyOnly>} />
          <Route path="/candidates" element={<CompanyOnly><CandidatesList /></CompanyOnly>} />
          <Route path="/candidates/:id" element={<CompanyOnly><CandidateProfile /></CompanyOnly>} />
          <Route path="/interviews" element={<CompanyOnly><InterviewsList /></CompanyOnly>} />
          <Route path="/interviews/new" element={<CompanyOnly><ScheduleWizard /></CompanyOnly>} />
          <Route path="/interviews/:id" element={<CompanyOnly><InterviewDetail /></CompanyOnly>} />
          <Route path="/interviews/:id/feedback" element={<CompanyOnly><Feedback /></CompanyOnly>} />
          <Route path="/interviews/:id/playback" element={<CompanyOnly><Playback /></CompanyOnly>} />
          <Route path="/questions" element={<CompanyOnly><Questions /></CompanyOnly>} />
          <Route path="/analytics" element={<CompanyOnly><Analytics /></CompanyOnly>} />
          <Route path="/team" element={<CompanyOnly><Team /></CompanyOnly>} />
          <Route path="/referrals" element={<CompanyOnly><ReferHome /></CompanyOnly>} />
          <Route path="/referrals/mine" element={<CompanyOnly><MyReferrals /></CompanyOnly>} />
          <Route path="/referrals/manage" element={<CompanyOnly><ReferralsManage /></CompanyOnly>} />
          <Route path="/settings" element={<CompanyOnly><Settings /></CompanyOnly>} />
          <Route path="/billing" element={<CompanyOnly><Billing /></CompanyOnly>} />
          <Route path="/invoices/:id" element={<CompanyOnly><InvoiceView /></CompanyOnly>} />
        </Route>
        <Route path="*" element={<div className="auth-wrap"><div className="card auth-card center"><h2>Page not found</h2><a href="/">Go home</a></div></div>} />
      </Routes>
    </Suspense>
  );
}
