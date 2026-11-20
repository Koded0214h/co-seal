// Placeholder mark — LinkLock's padlock/chain-link glyph was that project's own visual
// identity (golden-yellow brand), not generic code, so it isn't ported here. Swap this for
// a real CoSeal mark (a "seal" motif fits the name) when the brand is designed.
export function SealMark({ size = 40, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <circle cx="24" cy="24" r="22" fill="#14130F" />
      <circle cx="24" cy="24" r="22" stroke="#F7931A" strokeWidth="2" />
      <path d="M24 12l9 4.5v9c0 7-4.5 11-9 12.5-4.5-1.5-9-5.5-9-12.5v-9L24 12z" fill="#F7931A" fillOpacity="0.9" />
      <path d="M20 24l3 3 6-6" stroke="#14130F" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className = '', size = 40, showMark = true, sub = false }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {showMark && <SealMark size={size} />}
      <div className="leading-none">
        <div className="font-bold tracking-tight text-ink" style={{ fontSize: size * 0.5 }}>
          Co<span className="text-gold-deep">Seal</span>
        </div>
        {sub && <div className="eyebrow mt-1">Deals, sealed by both sides</div>}
      </div>
    </div>
  );
}
