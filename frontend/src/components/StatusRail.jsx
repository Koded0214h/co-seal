import { Check } from './Icons.jsx';

const HAPPY = ['CREATED', 'AWAITING_FUNDING', 'FUNDED', 'DISPATCHED', 'DELIVERED', 'REVIEW_PENDING', 'AWAITING_SIGNATURES', 'RELEASED'];
const DISPUTE = ['DISPUTED', 'UNDER_REVIEW', 'RESOLUTION_PROPOSED', 'AWAITING_SIGNATURES'];
const STEP_LABEL = {
  CREATED: 'Agreement created', AWAITING_FUNDING: 'Awaiting funding', FUNDED: 'Escrow funded',
  DISPATCHED: 'Dispatched + proof', DELIVERED: 'Delivered', REVIEW_PENDING: 'Review window',
  AWAITING_SIGNATURES: 'Awaiting signatures', RELEASED: 'Released to seller',
  DISPUTED: 'Disputed — frozen', UNDER_REVIEW: 'Arbitration', RESOLUTION_PROPOSED: 'Resolution proposed',
  REFUNDED: 'Refunded to buyer', SPLIT: 'Split resolution',
};

export function StatusRail({ state }) {
  const disputed = ['DISPUTED', 'UNDER_REVIEW', 'RESOLUTION_PROPOSED', 'REFUNDED', 'SPLIT'].includes(state);
  let steps;
  if (!disputed) {
    steps = HAPPY;
  } else {
    steps = ['CREATED', 'AWAITING_FUNDING', 'FUNDED', 'DISPATCHED', 'DELIVERED', ...DISPUTE];
    if (state === 'REFUNDED') steps.push('REFUNDED');
    if (state === 'SPLIT') steps.push('SPLIT');
    if (state === 'RELEASED') steps.push('RELEASED');
  }
  const idx = steps.indexOf(state);

  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const done = i < idx;
        const current = i === idx;
        const terminalBad = current && ['DISPUTED', 'REFUNDED'].includes(s);
        return (
          <li key={s} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && (
              <span className={`absolute left-[11px] top-6 bottom-0 w-0.5 ${done ? 'bg-gold-deep' : 'bg-line'}`} />
            )}
            <span
              className={`relative z-10 mt-0.5 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border-2 transition-colors
                ${done ? 'bg-gold-deep border-gold-deep text-ink'
                  : current
                  ? terminalBad ? 'bg-state-freeze border-state-freeze text-paper animate-pop-in'
                    : 'bg-gold border-gold-deep text-ink animate-pop-in ' + (state !== 'RELEASED' ? 'animate-pulse-ring' : '')
                  : 'bg-paper border-line text-transparent'}`}
            >
              {done ? <Check width={13} height={13} /> : <span className={`h-1.5 w-1.5 rounded-full ${current ? 'bg-current' : 'bg-line'}`} />}
            </span>
            <div className="pt-0.5">
              <div className={`text-sm font-medium ${current ? 'text-ink' : done ? 'text-ink/70' : 'text-muted'}`}>
                {STEP_LABEL[s]}
              </div>
              {current && <div className="eyebrow mt-0.5">current</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
