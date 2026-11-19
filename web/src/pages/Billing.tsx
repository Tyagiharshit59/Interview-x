import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fmtDate, get, money, post } from '../api';
import { Badge, Button, Card, ErrorBox, Loading, Meter, statusBadge, useConfirm, useLoad, useToast } from '../ui';

declare global { interface Window { Razorpay?: any } }
const loadRazorpay = () => new Promise<void>((res, rej) => {
  if (window.Razorpay) return res();
  const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load Razorpay')); document.body.appendChild(s);
});

export function Billing() {
  const toast = useToast(); const { confirm, node } = useConfirm();
  const { data, error, reload } = useLoad(() => get('/billing'));
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly'); const [coupon, setCoupon] = useState(''); const [couponInfo, setCouponInfo] = useState<any>(null); const [busy, setBusy] = useState('');
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const sub = data.subscription;
  const checkout = async (planCode: string) => {
    setBusy(planCode);
    try {
      const r = await post('/billing/checkout', { planCode, cycle, coupon: couponInfo ? coupon : undefined });
      if (r.gateway === 'razorpay') {
        await loadRazorpay();
        new window.Razorpay({ key: r.keyId, order_id: r.orderId, amount: r.total, currency: 'INR', name: 'IntervueX', description: 'Subscription',
          handler: async (resp: any) => { try { await post('/billing/razorpay/verify', resp); toast('Payment successful'); void reload(); } catch (e: any) { toast(e.message, 'error'); } } }).open();
      } else if (await confirm(`Development gateway: simulate a successful payment of ${money(r.total)}?`, false)) {
        await post(`/billing/dev-pay/${r.invoiceId}`); toast('Payment simulated'); void reload();
      }
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const u = data.usage;
  const rows: Array<[string, any]> = [['Team accounts', u.members], ['Interviews', u.interviews], ['Interview minutes', u.interview_minutes], ['Code runs', u.code_runs], ['AI requests', u.ai_calls], ['Recording storage (MB)', u.recording_mb]];
  return (
    <div className="stack">
      <h1>Billing & usage</h1>
      <div className="grid g2">
        <Card title="Current plan">{sub ? <div className="stack gap-sm"><div className="row"><b style={{ fontSize: '1.3rem' }}>{sub.plan}</b>{statusBadge(sub.status)}</div>
          {sub.status === 'trialing' && <div>Trial ends {fmtDate(sub.trialEndsAt, { dateStyle: 'medium' })}</div>}{sub.status !== 'trialing' && <div>Current period ends {fmtDate(sub.periodEnd, { dateStyle: 'medium' })}</div>}
          {sub.cancelAtPeriodEnd ? <div className="alert warn">Cancels at period end. <Button size="sm" onClick={async () => { await post('/billing/resume'); void reload(); }}>Keep subscription</Button></div> : sub.status === 'active' && <div><Button size="sm" onClick={async () => { if (await confirm('Cancel at the end of the current period? You keep access until then.')) { await post('/billing/cancel'); void reload(); } }}>Cancel subscription</Button></div>}</div> : <div>No subscription.</div>}</Card>
        <Card title="Usage this period"><div className="stack gap-sm">{rows.map(([l, m]) => <div key={l}><div className="small">{l}</div><Meter used={m.used} limit={m.limit} /></div>)}</div><p className="small muted">Limits are hard caps. Extra capacity or negotiated plans are available on request.</p></Card>
      </div>
      <Card title="Plans" actions={<div className="row"><Button size="sm" variant={cycle === 'monthly' ? 'primary' : undefined} onClick={() => setCycle('monthly')}>Monthly</Button><Button size="sm" variant={cycle === 'yearly' ? 'primary' : undefined} onClick={() => setCycle('yearly')}>Yearly</Button></div>}>
        <form className="row" style={{ marginBottom: 12 }} onSubmit={async e => { e.preventDefault(); try { const c = await post('/billing/coupon', { code: coupon }); setCouponInfo(c); toast(`Coupon applied: ${c.percentOff}% off`); } catch (x: any) { setCouponInfo(null); toast(x.message, 'error'); } }}>
          <input style={{ maxWidth: 200 }} placeholder="Coupon code" value={coupon} onChange={e => { setCoupon(e.target.value); setCouponInfo(null); }} aria-label="Coupon code" /><Button type="submit" size="sm">Apply</Button>{couponInfo && <Badge kind="ok">{couponInfo.percentOff}% off</Badge>}</form>
        <div className="grid g3">{data.plans.map((p: any) => {
          const price = cycle === 'yearly' ? p.price_yearly : p.price_monthly; const cur = sub?.planCode === p.code;
          return <div key={p.code} className={`card flat price ${cur ? 'pop' : ''}`}><h3>{p.name} {cur && <Badge kind="primary">Current</Badge>}</h3><div className="amt">₹{price.toLocaleString('en-IN')}<span className="small muted"> /{cycle === 'yearly' ? 'year' : 'month'}</span></div><div className="small muted">+ 18% GST. {p.description}</div>
            <Button variant={cur ? undefined : 'primary'} busy={busy === p.code} disabled={cur && sub.status === 'active'} onClick={() => checkout(p.code)}>{cur ? (sub.status === 'trialing' ? 'Subscribe' : 'Renew') : 'Choose plan'}</Button></div>;
        })}</div>
        <p className="small muted">Upgrades and downgrades take effect immediately on payment; proration is not applied. Enterprise plans are arranged with sales. Gateway: {data.gateway === 'dev' ? 'development simulator (set Razorpay keys for real payments)' : data.gateway}.</p>
      </Card>
      <Card title="Invoices & payments">{data.invoices.length ? <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Description</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody>{data.invoices.map((i: any) => <tr key={i.id}><td><Link to={`/invoices/${i.id}`}>{i.number}</Link></td><td>{i.description}</td><td>{fmtDate(i.issued_at, { dateStyle: 'medium' })}</td><td>{money(i.total)}</td><td>{statusBadge(i.status)}</td></tr>)}</tbody></table></div> : <div className="muted">No invoices yet.</div>}</Card>
      {node}
    </div>
  );
}

export function InvoiceView() {
  const { id } = useParams(); const { data, error } = useLoad(() => get(`/invoices/${id}`), [id]);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const b = data.billing_snapshot || {};
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="row between"><Link to="/billing">← Billing</Link><span className="row"><a className="btn" href={`/api/invoices/${id}/pdf`}>Download PDF</a><Button onClick={() => window.print()}>Print</Button></span></div>
      <Card>
        <div className="row between"><div><h1 style={{ marginBottom: 0 }}>Tax invoice</h1><div className="muted">{data.number}</div></div>{statusBadge(data.status)}</div>
        <div className="grid g2" style={{ margin: '16px 0' }}><div><b>From</b><br />{data.seller.name}<br />GSTIN: {data.seller.gstin}<br />State: {data.seller.state}<br />SAC: {data.seller.sac}</div><div><b>Billed to</b><br />{b.name}<br />{b.address}<br />State: {b.state || '—'}<br />GSTIN: {b.gst_number || 'Unregistered'}</div></div>
        <table><tbody><tr><td>{data.description}</td><td className="right">{money(data.subtotal + data.discount)}</td></tr>{data.discount > 0 && <tr><td>Discount {data.coupon_code && `(${data.coupon_code})`}</td><td className="right">−{money(data.discount)}</td></tr>}
          <tr><td>Taxable value</td><td className="right">{money(data.subtotal)}</td></tr>{data.cgst > 0 && <><tr><td>CGST @ 9%</td><td className="right">{money(data.cgst)}</td></tr><tr><td>SGST @ 9%</td><td className="right">{money(data.sgst)}</td></tr></>}{data.igst > 0 && <tr><td>IGST @ 18%</td><td className="right">{money(data.igst)}</td></tr>}
          <tr><th>Total</th><th className="right">{money(data.total)}</th></tr></tbody></table>
        <p className="small muted">Issued {fmtDate(data.issued_at)}{data.paid_at && ` · Paid ${fmtDate(data.paid_at)}`}. {data.note}</p>
      </Card>
    </div>
  );
}
