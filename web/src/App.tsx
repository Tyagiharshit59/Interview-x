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
  const { me } = useAuth();
  if (me?.user.isSuperAdmin && !me.company) return <Navigate to="/admin" replace />;
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
        <Route path="/camera/:token" element={<CameraCompanion />} />

        <Route path="/interviews/:id/room" element={needCompany(<Room />)} />
        <Route element={<Protected><Layout /></Protected>}>
          <Route path="/admin" element={<Admin />} />
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
          <Route path="/settings" element={<CompanyOnly><Settings /></CompanyOnly>} />
          <Route path="/billing" element={<CompanyOnly><Billing /></CompanyOnly>} />
          <Route path="/invoices/:id" element={<CompanyOnly><InvoiceView /></CompanyOnly>} />
        </Route>
        <Route path="*" element={<div className="auth-wrap"><div className="card auth-card center"><h2>Page not found</h2><a href="/">Go home</a></div></div>} />
      </Routes>
    </Suspense>
  );
}
