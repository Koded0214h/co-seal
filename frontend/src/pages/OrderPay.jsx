import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Page } from '../components/Layout.jsx';
import { SealMark } from '../components/Logo.jsx';
import { CopyField } from '../components/CopyField.jsx';
import { StatusRail } from '../components/StatusRail.jsx';
import { StateBadge } from '../components/StateBadge.jsx';
import { AiVerdict, AiComparison } from '../components/AiVerdict.jsx';
import { EvidenceUpload } from '../components/EvidenceUpload.jsx';
import { SigningPrompt } from '../components/SigningPrompt.jsx';
import { useToast } from '../components/Toast.jsx';
import { useOrder } from '../hooks/useOrder.js';
import { api } from '../lib/api.js';
import { sats, countdown } from '../lib/format.js';
import { Lock, Shield, Check, Alert, Spinner, Sparkles } from '../components/Icons.jsx';

export default function OrderPay() {
  const { ref } = useParams();
  const { order, loading, error, refresh } = useOrder(ref);

  if (loading) return <Page><Loader /></Page>;
  if (error || !order) return <Page><Missing refProp={ref} /></Page>;

  return (
    <Page max="max-w-4xl">
      <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6 lg:gap-8 items-start">
        <Ticket order={order} refresh={refresh} />
        <aside className="space-y-5">
          <div className="card p-5">
            <div className="eyebrow mb-3">Transaction status</div>
            <StatusRail state={order.state} />
          </div>
          <TrustNote order={order} />
        </aside>
      </div>
    </Page>
  );
}

function Ticket({ order, refresh }) {
  return (
    <div className="animate-rise">
      <div className="relative card overflow-hidden">
        {/* header */}
        <div className="bg-ink text-paper px-5 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <SealMark size={34} />
            <div>
              <div className="text-sm font-semibold leading-tight">Sealed by CoSeal</div>
              <div className="font-mono text-[11px] text-paper/60">{order.ref}</div>
            </div>
          </div>
          <StateBadge state={order.state} size="sm" />
        </div>

        {/* perforation */}
        <div className="relative h-3 bg-ink">
          <div className="absolute -left-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-canvas" />
          <div className="absolute -right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-canvas" />
          <div className="perf text-canvas h-full mx-2" />
        </div>

        {/* body */}
        <div className="px-5 sm:px-6 py-5 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="eyebrow">Item</div>
              <div className="mt-1 text-lg font-semibold text-ink leading-snug">{order.itemDescription}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="eyebrow">Amount</div>
              <div className="mt-1 font-mono text-2xl font-bold text-ink tabular-nums">{sats(order.amountSats)}</div>
            </div>
          </div>

          <PayOrStatus order={order} refresh={refresh} />
        </div>
      </div>
    </div>
  );
}

function buyerPubkeyOf(order) {
  return order.participants?.find((p) => p.role === 'BUYER')?.pubkey || '';
}

function PayOrStatus({ order, refresh }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function simulate() {
    setBusy(true);
    try { await api.simulateFunding(order.ref); await refresh(); toast('Escrow funded — locked', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  // LIVE transactions: funding must actually land on-chain — this polls for a confirmed UTXO.
  async function checkFunding() {
    setBusy(true);
    try {
      const res = await api.checkFunding(order.ref);
      if (res.fundingDetected === false) {
        toast('No on-chain funding detected yet — send it, then tap this again', 'error');
      } else {
        await refresh();
        toast('Escrow funded — locked', 'success');
      }
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  // A settlement is proposed and awaiting the buyer's signature.
  const pendingSettlement = order.settlements?.find((s) => s.status === 'AWAITING_SIGNATURES');
  if (order.state === 'AWAITING_SIGNATURES' && pendingSettlement) {
    return <SigningPrompt order={order} settlement={pendingSettlement} myPubkey={buyerPubkeyOf(order)} onDone={refresh} />;
  }

  if (order.state === 'CREATED' || order.state === 'AWAITING_FUNDING') {
    return (
      <div className="space-y-4">
        <div className="rounded-xl2 border border-gold/40 bg-gold-soft/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Shield width={18} height={18} className="text-gold-deep" />
            <span className="text-sm font-semibold text-ink">Fund this escrow address</span>
          </div>
          <CopyField label={`${order.bitcoinNetwork} escrow address · tap to copy`} value={order.escrow?.address} big />
        </div>
        <p className="text-[13px] leading-relaxed text-muted">
          Send <span className="font-mono text-ink">{sats(order.amountSats)}</span> from a Signet wallet.
          Once CoSeal verifies the on-chain funding, the escrow locks and the seller is told it is safe to dispatch.
        </p>
        <button onClick={checkFunding} disabled={busy} className="btn-ink w-full">
          {busy ? <><Spinner width={18} height={18} /> Checking for funding…</> : <>I've sent it</>}
        </button>
        <button onClick={simulate} disabled={busy} className="block w-full text-center text-[12px] text-gold-deep underline underline-offset-2">
          Demo: simulate the funding instead (Bitcoin RPC isn't wired up yet)
        </button>
      </div>
    );
  }

  if (order.state === 'FUNDED' || order.state === 'DISPATCHED' || order.state === 'IN_TRANSIT') {
    return (
      <div className="space-y-4">
        <LockedBanner amount={order.amountSats} />
        <div className="rounded-xl border border-line bg-canvas px-4 py-3 text-sm text-muted">
          {order.state === 'FUNDED'
            ? 'The seller has been told it is safe to dispatch. You will get a confirm link once delivery is reported.'
            : 'The seller dispatched with verified proof. A confirm link opens when delivery is reported.'}
        </div>
      </div>
    );
  }

  if (order.state === 'REVIEW_PENDING') return <ConfirmOrDispute order={order} refresh={refresh} />;

  if (order.state === 'RELEASED') return <Outcome tone="safe" icon={Check} title="Released to the seller" body="The item was confirmed and the escrow settled. This transaction is complete." order={order} />;
  if (order.state === 'REFUNDED') return <Outcome tone="freeze" icon={Check} title="Refunded to you" body="Your Bitcoin was returned cleanly from the isolated escrow." order={order} />;
  if (order.state === 'SPLIT') return <Outcome tone="review" icon={Check} title="Split resolution" body="The arbitrator split the funds based on the evidence. See the breakdown below." order={order} />;

  if (order.state === 'DISPUTED' || order.state === 'UNDER_REVIEW' || order.state === 'RESOLUTION_PROPOSED') {
    return (
      <div className="space-y-3">
        <Outcome tone={order.state === 'DISPUTED' ? 'freeze' : 'review'} icon={Alert}
          title={order.state === 'DISPUTED' ? 'Escrow frozen — seller notified' : 'Under arbitration'}
          body={order.state === 'DISPUTED'
            ? 'You raised a dispute. Nobody can move the escrow while it is open. The seller has been asked to accept or contest.'
            : 'An arbitrator is deciding using both sides’ evidence. Your funds stay frozen in escrow and safe.'} order={order} />
        {order.dispute?.aiComparison && <AiComparison comparison={order.dispute.aiComparison} />}
      </div>
    );
  }
  return null;
}

function LockedBanner({ amount }) {
  return (
    <div className="rounded-xl2 border border-state-safe/25 bg-state-safe/5 p-4 flex items-center gap-3.5">
      <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-state-safe text-paper animate-lock-click">
        <Lock width={24} height={24} />
      </span>
      <div>
        <div className="font-semibold text-ink">Funded &amp; locked</div>
        <div className="text-sm text-muted"><span className="font-mono">{sats(amount)}</span> is held in the isolated escrow.</div>
      </div>
    </div>
  );
}

function ConfirmOrDispute({ order, refresh }) {
  const toast = useToast();
  const [mode, setMode] = useState(null); // null | 'dispute'
  const [reason, setReason] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = order.reviewWindowExpiresAt ? order.reviewWindowExpiresAt - now : 0;

  async function confirm() {
    setBusy(true);
    try {
      await api.confirm(order.ref);
      await refresh();
      toast('Confirmed — release settlement proposed', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  async function submitDispute(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const form = new FormData();
      form.append('reason', reason || 'Item not as described');
      if (file) form.append('proof', file);
      const res = await api.dispute(order.ref, form);
      setResult(res);
      await refresh();
      toast('Dispute opened — escrow frozen', 'success');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  if (result) {
    return (
      <div className="space-y-3">
        <Outcome tone="freeze" icon={Alert} title="Escrow frozen — you're protected" body="Your dispute is on record and the seller has been pinged. The funds cannot move until it is resolved." order={order} />
        {result.assessment && <AiVerdict assessment={result.assessment} kind="problem" />}
        {result.comparison && <AiComparison comparison={result.comparison} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-state-review/25 bg-state-review/5 px-4 py-2.5">
        <span className="text-sm font-medium text-ink">Delivered — please confirm</span>
        <span className="font-mono text-sm text-state-review">{countdown(left)} left</span>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        If the item is correct, confirm to propose the release settlement. If there is a problem, tapping
        "Something's wrong" freezes the escrow — you are never forced to accept a bad order. If you do
        nothing, the review window expiring escalates to arbitration (not an auto-release — see PRD §6.4).
      </p>

      {mode !== 'dispute' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button onClick={confirm} disabled={busy} className="btn-gold">
            {busy ? <Spinner width={18} height={18} /> : <Check width={18} height={18} />} Confirm received
          </button>
          <button onClick={() => setMode('dispute')} disabled={busy} className="btn-danger">
            <Alert width={18} height={18} /> Something's wrong
          </button>
        </div>
      ) : (
        <form onSubmit={submitDispute} className="space-y-3 rounded-xl2 border border-line bg-canvas/60 p-4">
          <div>
            <label className="label" htmlFor="reason">What's the problem?</label>
            <input id="reason" className="input" placeholder="Wrong item / damaged / empty parcel…" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <EvidenceUpload file={file} onFile={setFile} label="Photo of the problem" hint="An unboxing shot works best — AI compares it to the seller's dispatch proof." />
          <div className="flex gap-2.5">
            <button type="submit" disabled={busy} className="btn-ink flex-1">
              {busy ? <><Spinner width={18} height={18} /> Submitting…</> : <>Freeze &amp; dispute</>}
            </button>
            <button type="button" onClick={() => setMode(null)} className="btn-ghost">Back</button>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted"><Sparkles width={13} height={13} className="text-gold-deep" /> Your photo's SHA-256 hash is recorded and checked by AI. You can dispute even without a photo.</p>
        </form>
      )}
    </div>
  );
}

function Outcome({ tone, icon: Icon, title, body, order }) {
  const cls = { safe: 'border-state-safe/25 bg-state-safe/5 text-state-safe', freeze: 'border-state-freeze/25 bg-state-freeze/5 text-state-freeze', review: 'border-state-review/25 bg-state-review/5 text-state-review' }[tone];
  const settlements = order.settlements?.filter((s) => s.status === 'BROADCAST') || [];
  return (
    <div className={`rounded-xl2 border p-4 ${cls}`}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-current/10"><Icon width={20} height={20} /></span>
        <div className="font-semibold text-ink">{title}</div>
      </div>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink/75">{body}</p>
      {settlements.map((s) => (
        <div key={s.id} className="mt-2 font-mono text-[11px] text-muted">
          {s.type} · {sats(s.amountSats)} · txid {s.txid || '—'}
        </div>
      ))}
    </div>
  );
}

function TrustNote({ order }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-2">
        <Shield width={18} height={18} className="text-gold-deep" />
        <span className="text-sm font-semibold text-ink">Why this is safe</span>
      </div>
      <ul className="space-y-2 text-[13px] leading-relaxed text-muted">
        <li className="flex gap-2"><Check width={15} height={15} className="mt-0.5 shrink-0 text-state-safe" /> Your Bitcoin isn't in CoSeal's pocket — it's in a 2-of-3 escrow tagged to <span className="font-mono text-ink">{order.ref}</span>.</li>
        <li className="flex gap-2"><Check width={15} height={15} className="mt-0.5 shrink-0 text-state-safe" /> A problem freezes the funds and routes to arbitration. A valid settlement always needs real signatures.</li>
        <li className="flex gap-2"><Check width={15} height={15} className="mt-0.5 shrink-0 text-state-safe" /> Network: <span className="font-mono text-ink">{order.bitcoinNetwork}</span> — this is a test network, not real-value Bitcoin.</li>
      </ul>
    </div>
  );
}

function Loader() {
  return <div className="flex items-center justify-center py-24 text-muted"><Spinner width={22} height={22} /> <span className="ml-2">Loading transaction…</span></div>;
}
function Missing({ refProp }) {
  return (
    <div className="text-center py-20">
      <SealMark size={54} className="mx-auto" />
      <h1 className="mt-4 text-xl font-semibold">Transaction not found</h1>
      <p className="mt-1 text-muted">We couldn't find <span className="font-mono">{refProp}</span>.</p>
      <Link to="/" className="btn-ghost mt-5 inline-flex">Back home</Link>
    </div>
  );
}
