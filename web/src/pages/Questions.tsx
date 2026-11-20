import { useState } from 'react';
import { del, get, post, put } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useLoad, useToast, PageHeader } from '../ui';

export function Questions() {
  const { can } = useAuth(); const toast = useToast(); const { confirm, node } = useConfirm();
  const [q, setQ] = useState(''); const [kind, setKind] = useState(''); const [edit, setEdit] = useState<any>(null);
  const { data, loading, error, reload } = useLoad(() => get(`/questions?${new URLSearchParams({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) })}`), [q, kind]);
  return (
    <div className="stack">
      <PageHeader eyebrow="Assessments" title="Question bank" description="Coding and system-design questions with starter code and test cases." actions={can('questions.write') && <Button variant="primary" onClick={() => setEdit({ title: '', prompt: '', difficulty: 'medium', kind: 'coding', category: '', languages: ['javascript', 'python'], starter_code: {}, time_limit_sec: 2, scoring_criteria: '', tests: [] })}>New question</Button>} />
      <div className="row"><input style={{ maxWidth: 260 }} placeholder="Search" value={q} onChange={e => setQ(e.target.value)} aria-label="Search questions" /><select style={{ maxWidth: 180 }} value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind"><option value="">All kinds</option><option value="coding">Coding</option><option value="system_design">System design</option><option value="concept">Concept</option></select></div>
      <ErrorBox error={error} />
      <Card>{loading ? <Loading /> : !data?.items.length ? <Empty title="No questions" /> : <div className="table-wrap"><table><thead><tr><th>Title</th><th>Kind</th><th>Difficulty</th><th>Tests</th><th /></tr></thead><tbody>
        {data.items.map((x: any) => <tr key={x.id}><td><b>{x.title}</b><div className="small muted">{x.category}</div></td><td>{x.kind.replace('_', ' ')}</td><td><Badge kind={x.difficulty === 'easy' ? 'ok' : x.difficulty === 'hard' ? 'danger' : 'warn'}>{x.difficulty}</Badge></td><td>{x.test_count}</td>
          <td className="right">{can('questions.write') && <div className="row" style={{ justifyContent: 'flex-end' }}><Button size="sm" onClick={async () => setEdit(await get(`/questions/${x.id}`))}>Edit</Button><Button size="sm" variant="danger" onClick={async () => { if (await confirm(`Delete "${x.title}"?`)) { await del(`/questions/${x.id}`); void reload(); } }}>Delete</Button></div>}</td></tr>)}</tbody></table></div>}</Card>
      {edit && <QEditor q={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); toast('Saved'); }} />}
      {node}
    </div>
  );
}

function QEditor({ q, onClose, onSaved }: { q: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ ...q, tests: q.tests || [] }); const [err, setErr] = useState<any>(null);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const setTest = (i: number, k: string, v: any) => set('tests', f.tests.map((t: any, n: number) => (n === i ? { ...t, [k]: v } : t)));
  return (
    <Modal title={q.id ? 'Edit question' : 'New question'} onClose={onClose} wide>
      <form className="stack" onSubmit={async e => { e.preventDefault(); setErr(null); const body = { title: f.title, prompt: f.prompt, difficulty: f.difficulty, kind: f.kind, category: f.category || null, languages: f.languages, starter_code: f.starter_code, time_limit_sec: Number(f.time_limit_sec), scoring_criteria: f.scoring_criteria || null, tests: f.tests.map((t: any) => ({ input: t.input, expected_output: t.expected_output, is_hidden: !!t.is_hidden, weight: Number(t.weight) || 1 })) }; try { q.id ? await put(`/questions/${q.id}`, body) : await post('/questions', body); onSaved(); } catch (x) { setErr(x); } }}>
        <ErrorBox error={err} />
        <div className="grid g2"><Field label="Title"><input required value={f.title} onChange={e => set('title', e.target.value)} /></Field><Field label="Category"><input value={f.category || ''} onChange={e => set('category', e.target.value)} /></Field>
          <Field label="Kind"><select value={f.kind} onChange={e => set('kind', e.target.value)}><option value="coding">Coding</option><option value="system_design">System design</option><option value="concept">Concept</option></select></Field>
          <Field label="Difficulty"><select value={f.difficulty} onChange={e => set('difficulty', e.target.value)}><option>easy</option><option>medium</option><option>hard</option></select></Field></div>
        <Field label="Problem statement"><textarea rows={6} required value={f.prompt} onChange={e => set('prompt', e.target.value)} /></Field>
        {f.kind === 'coding' && <>
          <div className="grid g2"><Field label="Starter code (JavaScript)"><textarea className="mono" rows={5} value={f.starter_code.javascript || ''} onChange={e => set('starter_code', { ...f.starter_code, javascript: e.target.value })} /></Field>
            <Field label="Starter code (Python)"><textarea className="mono" rows={5} value={f.starter_code.python || ''} onChange={e => set('starter_code', { ...f.starter_code, python: e.target.value })} /></Field></div>
          <Field label="Time limit per test (seconds)"><input type="number" min={1} max={15} value={f.time_limit_sec} onChange={e => set('time_limit_sec', e.target.value)} /></Field>
          <div><div className="row between"><b>Test cases</b><Button size="sm" type="button" onClick={() => set('tests', [...f.tests, { input: '', expected_output: '', is_hidden: false, weight: 1 }])}>+ Add test</Button></div>
            {f.tests.map((t: any, i: number) => <div key={i} className="card flat" style={{ marginTop: 8 }}><div className="grid g2"><Field label="Input (stdin)"><textarea className="mono" rows={3} value={t.input} onChange={e => setTest(i, 'input', e.target.value)} /></Field><Field label="Expected output"><textarea className="mono" rows={3} value={t.expected_output} onChange={e => setTest(i, 'expected_output', e.target.value)} /></Field></div>
              <div className="row between"><label className="check"><input type="checkbox" checked={!!t.is_hidden} onChange={e => setTest(i, 'is_hidden', e.target.checked)} />Hidden from candidate</label><label className="row small">Weight <input style={{ width: 70 }} type="number" min={1} value={t.weight} onChange={e => setTest(i, 'weight', e.target.value)} /></label><Button size="sm" type="button" onClick={() => set('tests', f.tests.filter((_: any, n: number) => n !== i))}>Remove</Button></div></div>)}</div></>}
        <Field label="Scoring criteria (for interviewers)"><textarea rows={3} value={f.scoring_criteria || ''} onChange={e => set('scoring_criteria', e.target.value)} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Save question</Button></div>
      </form>
    </Modal>
  );
}
