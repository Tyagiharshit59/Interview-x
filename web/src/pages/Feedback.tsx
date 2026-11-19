import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, put } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, ErrorBox, Field, Loading, useLoad, useToast } from '../ui';

const RECS = [['strong_hire', 'Strong hire'], ['hire', 'Hire'], ['hold', 'Hold'], ['no_hire', 'No hire']] as const;

function Stars({ value, onChange, label, disabled }: { value: number; onChange: (n: number) => void; label: string; disabled?: boolean }) {
  return <div className="stars" role="radiogroup" aria-label={label}>{[1, 2, 3, 4, 5].map(n => <button type="button" key={n} disabled={disabled} className={n <= value ? 'on' : ''} role="radio" aria-checked={value === n} aria-label={`${n} of 5`} onClick={() => onChange(n)}>★</button>)}</div>;
}

export function Feedback() {
  const { id } = useParams(); const { can } = useAuth(); const toast = useToast();
  const { data, error, reload } = useLoad(() => get(`/interviews/${id}/feedback`), [id]);
  const { data: cons } = useLoad(() => (can('feedback.viewAll') ? get(`/interviews/${id}/consolidated`) : Promise.resolve(null)), [id]);
  const [f, setF] = useState<any>({ ratings: {}, evidence: '', private_notes: '', recommendation: null });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [draftBusy, setDraftBusy] = useState(false);
  useEffect(() => { if (data?.mine) setF({ ratings: data.mine.ratings, evidence: data.mine.evidence || '', private_notes: data.mine.private_notes || '', recommendation: data.mine.recommendation }); }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const locked = !data.canSubmit || data.mine?.submitted;
  const save = async (submit: boolean) => { setBusy(true); setErr(null); try { await put(`/interviews/${id}/feedback`, { ...f, submit }); toast(submit ? 'Feedback submitted' : 'Draft saved'); void reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="row between"><h1>Feedback: {data.interview.title}</h1><Link to={`/interviews/${id}`}>← Back to interview</Link></div>
      <div className="alert">{data.note} Hiring decisions are made by people, not by scores.</div>
      <ErrorBox error={err} />
      {!data.canSubmit && <div className="alert warn">Only interviewers assigned to this interview can submit feedback.</div>}
      {data.mine?.submitted && <div className="alert ok">You submitted your feedback. It is locked.</div>}
      {data.canSubmit && <Card title="Your evaluation" actions={!locked && can('ai.use') && <Button size="sm" busy={draftBusy} onClick={async () => { setDraftBusy(true); try { const r = await post(`/interviews/${id}/ai/feedback-draft`); setF((p: any) => ({ ...p, evidence: (p.evidence ? p.evidence + '\n\n' : '') + `[AI draft — edit me]\n${r.content.evidence}` })); } catch (e: any) { toast(e.message, 'error'); } finally { setDraftBusy(false); } }}>✨ Draft evidence with AI</Button>}>
        <div className="stack">
          <table><tbody>{data.criteria.map((c: string) => <tr key={c}><td>{c}</td><td className="right"><Stars label={c} disabled={locked} value={f.ratings[c] || 0} onChange={n => setF({ ...f, ratings: { ...f.ratings, [c]: n } })} /></td></tr>)}</tbody></table>
          <Field label="Evidence-based notes" hint="Describe what you observed (answers, code, reasoning). Avoid judging traits like confidence."><textarea rows={6} disabled={locked} value={f.evidence} onChange={e => setF({ ...f, evidence: e.target.value })} /></Field>
          <Field label="Private notes" hint="Visible only to you."><textarea rows={3} disabled={locked} value={f.private_notes} onChange={e => setF({ ...f, private_notes: e.target.value })} /></Field>
          <div><div style={{ fontWeight: 600, marginBottom: 6 }}>Recommendation</div><div className="row" role="radiogroup" aria-label="Recommendation">{RECS.map(([v, l]) => <label key={v} className="check btn" style={{ cursor: locked ? 'default' : 'pointer', ...(f.recommendation === v ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : {}) }}><input type="radio" name="rec" disabled={locked} checked={f.recommendation === v} onChange={() => setF({ ...f, recommendation: v })} />{l}</label>)}</div></div>
          {!locked && <div className="row"><Button busy={busy} onClick={() => save(false)}>Save draft</Button><Button variant="primary" busy={busy} onClick={() => save(true)}>Submit feedback</Button></div>}
        </div>
      </Card>}
      {data.pendingFrom.length > 0 && <div className="alert">Waiting for: {data.pendingFrom.join(', ')}</div>}
      {cons && cons.submitted > 0 && <Card title="Consolidated"><div className="row">{Object.entries(cons.averages).map(([k, v]: any) => <Badge key={k} kind="info">{k}: {v}/5</Badge>)}</div><div className="row" style={{ marginTop: 8 }}>{Object.entries(cons.recommendations).map(([k, v]: any) => <Badge key={k} kind={k.includes('no') ? 'danger' : 'ok'}>{k.replace('_', ' ')} × {v}</Badge>)}</div><p className="small muted">{cons.note}</p></Card>}
      {data.others.length > 0 && <Card title="Other interviewers">{data.others.map((o: any) => <div key={o.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><b>{o.interviewer}</b> <Badge>{o.recommendation?.replace('_', ' ')}</Badge><div className="row small" style={{ margin: '4px 0' }}>{Object.entries(o.ratings).map(([k, v]: any) => <span key={k} className="chip gray">{k}: {v}</span>)}</div><div className="small">{o.evidence}</div></div>)}</Card>}
      {!data.mine?.submitted && !can('feedback.viewAll') && <p className="small muted">Other interviewers' feedback appears after you submit yours, to keep evaluations independent.</p>}
    </div>
  );
}
