import { Link } from 'react-router-dom';
import { get } from '../api';
import { useLoad, Loading } from '../ui';
import { useAuth } from '../auth';

function PubNav() {
  const { me } = useAuth();
  return (
    <header className="pub-nav">
      <Link to="/" className="brand" style={{ padding: 0 }}><span className="logo">▶</span>IntervueX</Link>
      <nav className="row">
        <Link to="/pricing">Pricing</Link>
        {me ? <Link className="btn primary" to={me.user.isSuperAdmin && !me.company ? '/admin' : '/dashboard'}>Open app</Link> : <><Link to="/login">Sign in</Link><Link className="btn primary" to="/register">Start free trial</Link></>}
      </nav>
    </header>
  );
}

const FEATURES = [
  ['🎥', 'Live interview room', 'Browser-based video, panel interviews, waiting room, chat, permissioned screen sharing and reconnection handling.'],
  ['💻', 'Collaborative coding', 'Monaco editor, 15 languages, isolated execution, hidden and public test cases, code history and playback.'],
  ['📱', 'Optional second camera', 'Candidate scans a QR code, reads a clear consent notice and shares a workspace angle from a phone. Never secret, never automatic.'],
  ['⏺️', 'Consent-based recording', 'Visible indicators, separate consent for each feed, retention rules, access logging and timeline bookmarks.'],
  ['🧠', 'AI assistance, human decisions', 'Question ideas, summaries and draft feedback clearly labelled as AI. No auto-rejection, no face or voice scoring.'],
  ['📋', 'Applicant tracking', 'JD and CV parsing, pipelines, tags, notes and transparent skill-match decision support.'],
  ['📈', 'Analytics', 'Funnel, interviewer load, durations and coding statistics with plain-language explanations.'],
  ['🔐', 'Built for privacy', 'Tenant isolation, role-based access, MFA, audit logs, short-lived signed links and data deletion workflows.'],
];

export function Home() {
  return (
    <div>
      <PubNav />
      <section className="hero">
        <span className="badge primary">Recruitment · Live interviews · Coding · Billing</span>
        <h1 style={{ marginTop: 14 }}>Run fair, structured technical interviews in one place</h1>
        <p>IntervueX combines your applicant pipeline, live video interviews, collaborative coding assessments and evaluation workflow, with privacy controls your candidates can see.</p>
        <div className="row" style={{ justifyContent: 'center' }}><Link className="btn primary" to="/register">Start 14-day free trial</Link><Link className="btn" to="/pricing">See pricing</Link></div>
      </section>
      <section className="section"><div className="grid g4">{FEATURES.map(([i, t, d]) => <div key={t} className="card feat"><div className="ico" aria-hidden>{i}</div><h3>{t}</h3><p className="muted small">{d}</p></div>)}</div></section>
      <footer className="footer">© IntervueX. A working product name; replace it any time. Compliance claims require your own legal review.</footer>
    </div>
  );
}

export function PricingPage() {
  const { data, loading } = useLoad(() => get('/public/plans'));
  const label: Record<string, string> = { members: 'team accounts', interviews_per_month: 'interviews / month', code_runs_per_month: 'code runs / month', ai_calls_per_month: 'AI requests / month', recording_retention_days: 'days recording retention' };
  return (
    <div>
      <PubNav />
      <section className="section">
        <h1 className="center">Simple plans that grow with your hiring</h1>
        <p className="center muted">{data?.gstNote} Enterprise customers get negotiated limits, SSO, API access and SLA. <a href="mailto:sales@example.com">Contact sales</a></p>
        {loading ? <Loading /> : (
          <div className="grid g3" style={{ marginTop: 24 }}>
            {data.items.map((p: any) => {
              const e = p.entitlements; const unl = (v: number) => (v === -1 ? 'Unlimited' : v);
              return (
                <div key={p.code} className={`card price ${p.code === 'professional' ? 'pop' : ''}`}>
                  <h2>{p.name} {p.code === 'professional' && <span className="badge primary">Popular</span>}</h2>
                  <div className="muted small">{p.description}</div>
                  <div className="amt">₹{p.price_monthly.toLocaleString('en-IN')}<span className="muted small"> /month</span></div>
                  <div className="muted small">or ₹{p.price_yearly.toLocaleString('en-IN')}/year</div>
                  <ul>
                    {Object.keys(label).filter(k => e[k] !== undefined && e[k] !== 0).map(k => <li key={k}>{unl(e[k])} {label[k]}</li>)}
                    {e.coding && <li>Collaborative coding</li>}{e.recording && <li>Consent-based recording</li>}{e.ai && <li>AI assistance</li>}{e.secondary_camera && <li>QR secondary camera</li>}{e.analytics && <li>Analytics</li>}{e.custom_evaluation && <li>Custom evaluation forms</li>}
                  </ul>
                  <Link className={`btn ${p.code === 'professional' ? 'primary' : ''}`} to="/register">Start free trial</Link>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
