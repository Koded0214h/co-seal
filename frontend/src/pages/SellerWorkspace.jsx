import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Page } from '../components/Layout.jsx';
import { SealMark } from '../components/Logo.jsx';
import { CopyField } from '../components/CopyField.jsx';
import { StatusRail } from '../components/StatusRail.jsx';
import { StateBadge } from '../components/StateBadge.jsx';
import { AiVerdict, AiComparison } from '../components/AiVerdict.jsx';
import { EvidenceUpload } from '../components/EvidenceUpload.jsx';
import { MessageFeed } from '../components/MessageFeed.jsx';
import { SigningPrompt } from '../components/SigningPrompt.jsx';
import { useToast } from '../components/Toast.jsx';
import { useOrder } from '../hooks/useOrder.js';
import { api } from '../lib/api.js';
import { sats, countdown } from '../lib/format.js';
import { Lock, Truck, Check, Alert, Shield, Spinner, Sparkles } from '../components/Icons.jsx';

function sellerPubkeyOf(order) {
  return order.participants?.find((p) => p.role === 'SELLER')?.pubkey || '';
}

export default function SellerWorkspace() {
  const { ref } = useParams();
  const { order, loading, error, refresh } = useOrder(ref);

  if (loading) return <Page><div className="flex items-center justify-center py-24 text-muted"><Spinner width={22} height={22} /><span className="ml-2">Loading…</span></div></Page>;
  if (error || !order) return <Page><div className="text-center py-20"><SealMark size={54} className="mx-auto" /><h1 className="mt-4 text-xl font-semibold">Transaction not found</h1><Link to="/" className="btn-ghost mt-5 inline-flex">Back home</Link></div></Page>;

  return (
    <Page max="max-w-4xl">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <div className="eyebrow">Seller workspace</div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2.5 mt-1">
            {order.itemDescription}
          </h1>
          <p className="text-sm text-muted font-mono mt-0.5">{order.ref} · {sats(order.amountSats)}</p>
        </div>
        <StateBadge state={order.state} />
      </div>

      <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6 lg:gap-8 items-start">
        <div className="space-y-5">
          <SellerAction order={order} refresh={refresh} />
        </div>
        <aside className="space-y-5">
          <div className="card p-5"><div className="eyebrow mb-3">Transaction status</div><StatusRail state={order.state} /></div>
          {order.notifications?.some((m) => m.audience === 'SELLER') && (
            <div className="card p-5">
              <div className="eyebrow mb-3">Your notifications</div>
              <MessageFeed messages={order.notifications} audience="SELLER" />
            </div>
          )}
        </aside>
      </div>
    </Page>
  );
}

function SellerAction({ order, refresh }) {
  const pendingSettlement = order.settlements?.find((s) => s.status === 'AWAITING_SIGNATURES');
  if (order.state === 'AWAITING_SIGNATURES' && pendingSettlement) {
    return (
      <Panel tone="gold">
        <p className="text-sm text-muted mb-3">A settlement has been proposed and needs your signature to complete.</p>
        <SigningPrompt order={order} settlement={pendingSettlement} myPubkey={sellerPubkeyOf(order)} onDone={refresh} />
      </Panel>
    );
  }
  if (order.state === 'CREATED' || order.state === 'AWAITING_FUNDING') return <AwaitingFunding order={order} />;
  if (order.state === 'FUNDED') return <DispatchAndProve order={order} refresh={refresh} />;
  if (order.state === 'DISPATCHED' || order.state === 'IN_TRANSIT') return <MarkDelivered order={order} refresh={refresh} />;
  if (order.state === 'REVIEW_PENDING') return <AwaitingConfirm order={order} />;
  if (order.state === 'DISPUTED') return <RespondToDispute order={order} refresh={refresh} />;
  if (order.state === 'UNDER_REVIEW' || order.state === 'RESOLUTION_PROPOSED') return <UnderReview order={order} />;
  return <Terminal order={order} />;
}

function Panel({ children, tone = 'plain' }) {
  const cls = { plain: 'card', gold: 'rounded-xl2 border border-gold/40 bg-gold-soft/40', safe: 'rounded-xl2 border border-state-safe/25 bg-state-safe/5', freeze: 'rounded-xl2 border border-state-freeze/25 bg-state-freeze/5' }[tone];
  return <div className={`${cls} p-5 sm:p-6 animate-rise`}>{children}</div>;
}

function AwaitingFunding({ order }) {
  const origin = window.location.origin;
  return (
    <Panel>
      <div className="flex items-center gap-2 mb-1"><Lock width={18} height={18} className="text-muted" /><h2 className="font-semibold text-ink">Waiting for the buyer to fund escrow</h2></div>
      <p className="text-sm text-muted mb-4">Share the transaction link. You'll be told the second the escrow is funded — then you dispatch.</p>
      <CopyField label="Transaction link — share with the buyer" value={`${origin}/t/${order.ref}`} />
      <div className="mt-4 rounded-xl border border-line bg-canvas px-4 py-3">
        <div className="eyebrow mb-1">Escrow address for this transaction</div>
        <div className="font-mono text-ink text-sm break-all">{order.escrow?.address}</div>
      </div>
    </Panel>
  );
}

function DispatchAndProve({ order, refresh }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [dispatchRef, setDispatchRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [flag, setFlag] = useState(null); // assessment that blocked progress

  async function submit(acknowledge = false) {
    if (!file) return toast('Add a photo of the sealed item', 'error');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('dispatchReference', dispatchRef);
      form.append('proof', file);
      if (acknowledge) form.append('acknowledgeFlag', 'true');
      await api.dispatch(order.ref, form);
      await refresh();
      toast('Dispatched — proof on record', 'success');
    } catch (e) {
      if (e.status === 422 && e.data?.assessment) {
        setFlag(e.data.assessment);
        toast('AI flagged this proof', 'error');
      } else toast(e.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <Panel tone="gold">
      <div className="flex items-center gap-2.5 mb-1">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-state-safe text-paper"><Check width={18} height={18} /></span>
        <div><h2 className="font-semibold text-ink">Safe to dispatch</h2><p className="text-xs text-muted"><span className="font-mono">{sats(order.amountSats)}</span> is locked in the escrow.</p></div>
      </div>
      <p className="text-[13px] leading-relaxed text-muted my-3">
        Upload a photo of the actual sealed item as you dispatch it. Its SHA-256 hash is recorded —
        your protection if the buyer later disputes. AI checks it's genuine before the transaction can progress.
      </p>
      <div className="space-y-3">
        <EvidenceUpload file={file} onFile={(f) => { setFile(f); setFlag(null); }} label="Photo of the sealed item" hint="Show the packaging / parcel too, so it can't be swapped later." />
        <div>
          <label className="label" htmlFor="dref">Dispatch reference <span className="text-muted font-normal">(courier tracking, optional)</span></label>
          <input id="dref" className="input font-mono" placeholder="DHL-99823" value={dispatchRef} onChange={(e) => setDispatchRef(e.target.value)} />
        </div>
        {flag && (
          <div className="space-y-2.5">
            <AiVerdict assessment={flag} kind="dispatch" />
            <div className="flex gap-2.5">
              <button onClick={() => setFile(null)} className="btn-ghost flex-1">Re-upload genuine proof</button>
              <button onClick={() => submit(true)} disabled={busy} className="btn-danger flex-1" title="Override the AI flag (recorded)">Submit anyway</button>
            </div>
          </div>
        )}
        {!flag && (
          <button onClick={() => submit(false)} disabled={busy || !file} className="btn-gold w-full">
            {busy ? <><Spinner width={18} height={18} /> Verifying proof…</> : <><Truck width={18} height={18} /> Mark dispatched with proof</>}
          </button>
        )}
      </div>
    </Panel>
  );
}

function MarkDelivered({ order, refresh }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const sellerEv = order.evidence?.find((e) => e.side === 'SELLER');
  async function deliver() {
    setBusy(true);
    try { await api.deliver(order.ref); await refresh(); toast("Delivery reported — buyer's review window is open", 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Panel tone="safe">
      <div className="flex items-center gap-2 mb-1"><Truck width={18} height={18} className="text-state-safe" /><h2 className="font-semibold text-ink">Dispatched with verified proof</h2></div>
      <p className="text-sm text-muted mb-3">When the item reaches the buyer, report delivery to open their review window. If they go silent, the window escalates to arbitration — it does not auto-release (no backend timer can spend Bitcoin).</p>
      {sellerEv && (
        <div className="mb-3">
          <img src={sellerEv.url} alt="Your dispatch proof" className="max-h-40 rounded-lg border border-line object-contain" />
          {order.assessments?.find((a) => a.evidenceId === sellerEv.id) && (
            <div className="mt-2"><AiVerdict assessment={order.assessments.find((a) => a.evidenceId === sellerEv.id).assessment} kind="dispatch" /></div>
          )}
        </div>
      )}
      <button onClick={deliver} disabled={busy} className="btn-gold w-full">{busy ? <Spinner width={18} height={18} /> : <Check width={18} height={18} />} Report delivered</button>
    </Panel>
  );
}

function AwaitingConfirm({ order }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = order.reviewWindowExpiresAt ? order.reviewWindowExpiresAt - now : 0;
  return (
    <Panel>
      <div className="flex items-center gap-2 mb-1"><Shield width={18} height={18} className="text-gold-deep" /><h2 className="font-semibold text-ink">Waiting on the buyer</h2></div>
      <p className="text-sm text-muted mb-3">The buyer can confirm to propose your release settlement. If they do nothing, the window expiring escalates to arbitration — someone still has to sign off, but silence can't hold your funds forever.</p>
      <div className="flex items-center justify-between rounded-xl border border-state-review/25 bg-state-review/5 px-4 py-3">
        <span className="text-sm font-medium text-ink">Escalates to arbitration in</span>
        <span className="font-mono text-lg text-state-review">{countdown(left)}</span>
      </div>
    </Panel>
  );
}

function RespondToDispute({ order, refresh }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const buyerEv = order.evidence?.find((e) => e.side === 'BUYER');
  const sellerEv = order.evidence?.find((e) => e.side === 'SELLER');

  async function respond(response) {
    setBusy(true);
    try {
      await api.sellerResponse(order.ref, response);
      await refresh();
      toast(response === 'ACCEPT' ? 'Escalated to arbitration (you accepted)' : 'Contested — escalated to arbitration', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <Panel tone="freeze">
      <div className="flex items-center gap-2 mb-1"><Alert width={18} height={18} className="text-state-freeze" /><h2 className="font-semibold text-ink">The buyer disputed</h2></div>
      <p className="text-sm text-muted mb-3">Reason: <span className="text-ink">"{order.dispute?.reason}"</span>. The escrow is frozen — nobody can move it. Both ACCEPT and CONTEST go to an arbitrator; ACCEPT just tells them you agree to a refund.</p>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {sellerEv && <Evidence label="Your dispatch proof" ev={sellerEv} order={order} kind="dispatch" />}
        {buyerEv && <Evidence label="Buyer's problem proof" ev={buyerEv} order={order} kind="problem" />}
      </div>
      {order.dispute?.aiComparison && <div className="mb-4"><AiComparison comparison={order.dispute.aiComparison} /></div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button onClick={() => respond('ACCEPT')} disabled={busy} className="btn-ghost">Accept (recommend refund)</button>
        <button onClick={() => respond('CONTEST')} disabled={busy} className="btn-ink">{busy ? <Spinner width={18} height={18} /> : <Shield width={18} height={18} />} Contest (I dispatched correctly)</button>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted"><Sparkles width={13} height={13} className="text-gold-deep" /> An arbitrator reviews both sides with the AI evidence summary. Neither side can force the money.</p>
    </Panel>
  );
}

function Evidence({ label, ev, order, kind }) {
  const assessment = order.assessments?.find((a) => a.evidenceId === ev.id)?.assessment;
  return (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      <img src={ev.url} alt={label} className="w-full h-32 object-cover rounded-lg border border-line" />
      {assessment && <div className="mt-1.5"><AiVerdict assessment={assessment} kind={kind} /></div>}
    </div>
  );
}

function UnderReview({ order }) {
  return (
    <Panel tone="freeze">
      <div className="flex items-center gap-2 mb-1"><Alert width={18} height={18} className="text-state-review" /><h2 className="font-semibold text-ink">Under arbitration</h2></div>
      <p className="text-sm text-muted">An arbitrator is deciding with both sides' evidence and the AI summary. The funds stay frozen — safe — until a settlement is proposed and signed.</p>
      {order.dispute?.aiComparison && <div className="mt-3"><AiComparison comparison={order.dispute.aiComparison} /></div>}
    </Panel>
  );
}

function Terminal({ order }) {
  const released = order.state === 'RELEASED';
  const settlements = order.settlements?.filter((s) => s.status === 'BROADCAST') || [];
  return (
    <Panel tone={released ? 'safe' : 'freeze'}>
      <div className="flex items-center gap-2.5 mb-1">
        <span className={`flex h-10 w-10 items-center justify-center rounded-full ${released ? 'bg-state-safe' : 'bg-state-freeze'} text-paper`}><Check width={20} height={20} /></span>
        <h2 className="font-semibold text-ink">{released ? 'Paid out to you' : order.state === 'SPLIT' ? 'Split resolution' : "Refunded to the buyer"}</h2>
      </div>
      <p className="text-sm text-muted mt-1">
        {released ? 'The escrow settled to your Bitcoin address.' : order.state === 'SPLIT' ? 'The arbitrator split the funds based on the evidence.' : "The dispute resolved in the buyer's favour and the funds were returned."}
      </p>
      {settlements.map((s) => (
        <div key={s.id} className="mt-2 font-mono text-[11px] text-muted">{s.type} · {sats(s.amountSats)} · txid {s.txid || '—'}</div>
      ))}
    </Panel>
  );
}
