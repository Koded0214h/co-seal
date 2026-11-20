import { useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { sats, shortPubkey } from '../lib/format.js';
import { Shield, Spinner, Lock } from './Icons.jsx';

/**
 * Collects a participant's signature over the currently-proposed settlement PSBT.
 *
 * TODO (not real yet — see backend/src/lib/bitcoin.js): a real wallet integration (a
 * browser extension wallet, or a NIP-07-style signer) should display the PSBT's actual
 * outputs for the participant to review, sign it client-side, and hand back only the
 * resulting signature — the private key must never pass through this form or the backend
 * (PRD §9). Today this just collects two freeform strings as a stand-in so the settlement
 * state machine (PROPOSED → AWAITING_SIGNATURES → BROADCAST) can be exercised end to end.
 */
export function SigningPrompt({ order, settlement, myPubkey, onDone }) {
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const amount = settlement?.amountSats ?? order.amountSats;

  async function submit(e) {
    e.preventDefault();
    if (!myPubkey) return toast('No pubkey on file for this participant', 'error');
    if (!signature.trim()) return toast('Enter a signature', 'error');
    setBusy(true);
    try {
      await api.sign(order.ref, settlement.type, myPubkey, signature.trim());
      toast('Signature recorded', 'success');
      onDone?.();
    } catch (err) {
      toast(err.message || 'Could not record signature', 'error');
    } finally { setBusy(false); }
  }

  if (!settlement) return null;
  const already = (settlement.signatures || []).some((s) => s.pubkey === myPubkey);

  return (
    <div className="rounded-xl2 border border-gold/50 bg-gold-soft/50 p-4 sm:p-5 animate-pop-in">
      <div className="flex items-center gap-2.5 mb-1">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-gold"><Lock width={18} height={18} /></span>
        <div>
          <h3 className="font-semibold text-ink">Sign the {settlement.type.toLowerCase()} settlement</h3>
          <p className="text-xs text-muted">{sats(amount)} — {(settlement.signatures || []).length}/2 signatures collected.</p>
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-muted my-3">
        This should be a wallet-signed PSBT review, not a text field — see the TODO in
        SigningPrompt.jsx. For now, paste the signature your wallet produced for pubkey{' '}
        <span className="font-mono">{shortPubkey(myPubkey)}</span>.
      </p>
      {already ? (
        <p className="text-sm font-medium text-state-safe">You've already signed — waiting on the other participant.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2.5">
          <input
            className="input font-mono text-sm flex-1"
            placeholder="signature"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            aria-label="PSBT signature"
          />
          <button type="submit" disabled={busy} className="btn-gold">
            {busy ? <><Spinner width={18} height={18} /> Signing…</> : <><Shield width={18} height={18} /> Sign</>}
          </button>
        </form>
      )}
    </div>
  );
}
