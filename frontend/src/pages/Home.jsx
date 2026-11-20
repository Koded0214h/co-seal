import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout.jsx';
import { CopyField } from '../components/CopyField.jsx';
import { useToast } from '../components/Toast.jsx';
import { Lock, Shield, Sparkles, Link as LinkIcon, Arrow, Spinner, Check } from '../components/Icons.jsx';
import { api } from '../lib/api.js';
import { sats } from '../lib/format.js';

const STEPS = [
  { t: 'Drop a link', d: 'Describe the deal once. CoSeal mints an isolated 2-of-3 Bitcoin escrow and hands you a link to share.' },
  { t: 'Buyer funds the escrow', d: 'The buyer pays Signet BTC into the escrow address. CoSeal verifies the real on-chain funding before anything moves forward.' },
  { t: 'Dispatch with proof', d: 'The seller uploads a photo of the sealed item. AI checks it is genuine before the deal can progress.' },
  { t: 'Release or dispute', d: 'Buyer confirms and the release PSBT gets signed. A problem freezes the escrow and routes to arbitration — cleanly resolvable.' },
];

export default function Home() {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({
    itemDescription: '', amountSats: '', sellerPubkey: '', sellerName: '', buyerPubkey: '', deliveryConditions: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(null);
  const toast = useToast();

  useEffect(() => {
    api.status().then(setStatus).catch(() => {});
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const valid = useMemo(() =>
    form.itemDescription.trim().length > 1 && Number(form.amountSats) > 0 && form.sellerPubkey.trim().length > 0, [form]);

  async function submit(e) {
    e.preventDefault();
    if (!valid) return toast('Fill in the item, amount (sats) and your seller pubkey', 'error');
    setSubmitting(true);
    try {
      const order = await api.createOrder({ ...form, amountSats: Number(form.amountSats) });
      setCreated(order);
      toast('Escrow transaction created', 'success');
    } catch (err) {
      toast(err.message || 'Could not create transaction', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Page>
      {/* HERO */}
      <section className="grid lg:grid-cols-[1.05fr_0.95fr] gap-8 lg:gap-12 items-start">
        <div className="pt-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-1.5 text-xs font-medium text-muted shadow-sm">
            <Shield width={14} height={14} className="text-gold-deep" />
            Dakar Bitcoin Hack by BTrust · non-custodial escrow
          </span>
          <h1 className="mt-5 text-4xl sm:text-5xl lg:text-[3.4rem] font-bold leading-[1.03] tracking-tight text-ink">
            Deals, sealed<br />by <span className="relative whitespace-nowrap">both sides
              <svg className="absolute -bottom-1 left-0 w-full" height="10" viewBox="0 0 200 10" fill="none" preserveAspectRatio="none"><path d="M2 7c40-5 158-5 196 0" stroke="#F5B301" strokeWidth="4" strokeLinecap="round"/></svg>
            </span>.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-muted max-w-xl">
            A shareable transaction link funds a Bitcoin multisig escrow — no conventional
            signup, no pooled wallet. CoSeal coordinates the agreement, the evidence and the
            settlement; it <span className="text-ink font-semibold">never holds your money</span>.
          </p>

          <div className="mt-7 grid sm:grid-cols-2 gap-3 max-w-xl">
            {STEPS.map((s, i) => (
              <div key={s.t} className="flex gap-3 rounded-xl2 border border-line bg-paper p-3.5 shadow-sm transition-shadow hover:shadow-ticket">
                <span className="font-mono text-[11px] text-gold-deep mt-0.5">0{i + 1}</span>
                <div>
                  <div className="text-sm font-semibold text-ink">{s.t}</div>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{s.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* GENERATOR / RESULT */}
        <div className="lg:sticky lg:top-24 relative">
          {created ? (
            <CreatedCard order={created} onReset={() => { setCreated(null); setForm((f) => ({ ...f, itemDescription: '', amountSats: '' })); }} />
          ) : (
            <form onSubmit={submit} className="card p-5 sm:p-6 animate-rise">
              <div className="mb-4 pr-16">
                <h2 className="text-lg font-bold text-ink leading-tight">Create a transaction</h2>
                <p className="text-xs text-muted">No conventional account needed.</p>
              </div>

              <div className="space-y-3.5">
                <div>
                  <label className="label" htmlFor="item">What are you selling?</label>
                  <input id="item" className="input" placeholder="Vintage film camera" value={form.itemDescription} onChange={set('itemDescription')} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label" htmlFor="amount">Amount (sats)</label>
                    <input id="amount" inputMode="numeric" className="input font-mono" placeholder="150000" value={form.amountSats} onChange={set('amountSats')} />
                  </div>
                  <div>
                    <label className="label" htmlFor="buyer">Buyer pubkey <span className="text-muted font-normal">(optional)</span></label>
                    <input id="buyer" className="input font-mono text-xs" placeholder="npub1…" value={form.buyerPubkey} onChange={set('buyerPubkey')} />
                  </div>
                </div>

                <div className="rounded-xl border border-line bg-canvas/70 p-3.5 space-y-3">
                  <div className="eyebrow flex items-center gap-1.5"><Arrow width={13} height={13} /> Your escrow signing key</div>
                  <div>
                    <label className="label" htmlFor="spk">Seller pubkey</label>
                    <input id="spk" className="input font-mono text-xs" placeholder="the pubkey your wallet will sign with" value={form.sellerPubkey} onChange={set('sellerPubkey')} />
                  </div>
                  <div>
                    <label className="label" htmlFor="sname">Your name <span className="text-muted font-normal">(optional)</span></label>
                    <input id="sname" className="input" placeholder="Boutique XYZ" value={form.sellerName} onChange={set('sellerName')} />
                  </div>
                  <div>
                    <label className="label" htmlFor="dc">Delivery conditions <span className="text-muted font-normal">(optional)</span></label>
                    <input id="dc" className="input" placeholder="Ships within 3 days, tracked" value={form.deliveryConditions} onChange={set('deliveryConditions')} />
                  </div>
                </div>
              </div>

              <button type="submit" disabled={!valid || submitting} className="btn-gold w-full mt-4">
                {submitting ? <><Spinner width={18} height={18} /> Creating…</> : <><Lock width={18} height={18} /> Create escrow transaction</>}
              </button>
              {status && (
                <p className="mt-3 text-center text-[11px] font-mono text-muted">
                  {status.bitcoinMode} · {status.bitcoinNetwork} · review window {status.reviewWindow}
                </p>
              )}
            </form>
          )}
        </div>
      </section>
    </Page>
  );
}

function CreatedCard({ order, onReset }) {
  const origin = window.location.origin;
  return (
    <div className="card p-5 sm:p-6 animate-pop-in">
      <div className="flex items-center gap-2 text-state-safe mb-1">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-state-safe/10"><Check width={18} height={18} /></span>
        <span className="font-semibold">Transaction ready</span>
      </div>
      <p className="text-sm text-muted mb-4">
        {order.ref} · {order.itemDescription} · <span className="font-mono">{sats(order.amountSats)}</span>
      </p>

      <div className="space-y-3">
        <CopyField label="Transaction link — share this" value={`${origin}/t/${order.ref}`} />
        <CopyField label="Your seller workspace" value={`${origin}/seller/${order.ref}`} />
      </div>

      <div className="mt-4 flex flex-col sm:flex-row gap-2.5">
        <Link to={`/t/${order.ref}`} className="btn-gold flex-1"><LinkIcon width={17} height={17} /> Open transaction page</Link>
        <Link to={`/seller/${order.ref}`} className="btn-ghost flex-1">Manage <Arrow width={16} height={16} /></Link>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-xl bg-gold-soft/60 border border-gold/30 px-3.5 py-2.5">
        <Sparkles width={16} height={16} className="mt-0.5 shrink-0 text-gold-deep" />
        <p className="text-[12.5px] leading-snug text-ink/80">
          Escrow address: <span className="font-mono">{order.escrow?.address}</span>.{' '}
          Bitcoin funding/escrow isn't wired up yet (see backend/src/lib/bitcoin.js) — this is a simulated address.
        </p>
      </div>

      <button onClick={onReset} className="mt-3 w-full text-center text-sm text-muted hover:text-ink transition-colors cursor-pointer">
        + Create another transaction
      </button>
    </div>
  );
}
