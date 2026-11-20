# Port from LinkLock — what moved, what's stubbed, what's still missing

This project started as a code port from a sibling hackathon project, **LinkLock**
(zero-signup escrow over Monnify bank transfers). CoSeal's actual payment rail is
completely different — Bitcoin multisig + Nostr, not a bank API — so this was a
scaffolding port, not a copy-paste. This file records exactly what happened so nothing
gets silently assumed to be more finished than it is. Delete this file once the real
Bitcoin/Nostr integration lands and these notes stop being useful.

## Ported close to as-is

- `backend/src/lib/ai.js` — the evidence-verification AI client (Groq vision model).
  Logic, degradation behavior, and JSON-extraction/retry handling are untouched; only
  terminology was rebranded (vendor→seller, LinkLock→CoSeal, REVERSE→REFUND in the
  recommendation enum).
- `backend/src/lib/upload.js` / `ids.js` — multer config and id generation, unchanged
  apart from the `cs-` ref prefix. Added `hashUploadedFile()` for PRD §9's SHA-256
  evidence-hash requirement (LinkLock didn't have this).
- `backend/src/lib/notify.js` — renamed `messages` → `notifications` table/functions to
  avoid confusion with Nostr DMs, otherwise the same append-and-list pattern.
- Frontend component shells (`Layout`, `Toast`, `CopyField`, `Icons`, `EvidenceUpload`,
  `AiVerdict`/`AiComparison`, `MessageFeed`, `StateBadge`) — structure and most markup
  kept, only copy/terminology updated.
- Project scaffolding: `package.json` scripts, Vite/Tailwind/PostCSS config, Dockerfile
  pattern, `.gitignore`.

## Redesigned around CoSeal's actual lifecycle (PRD-driven, not LinkLock's)

- `backend/src/stateMachine.js` — all new states (`CREATED` → `AWAITING_FUNDING` →
  `FUNDED` → `DISPATCHED` → ... → `RELEASED`/`REFUNDED`/`SPLIT`), built from PRD §6.
  **One deliberate deviation from the PRD**: §6.1's ASCII diagram shows a
  `RELEASE_PENDING` state and a direct seller-ACCEPT path out of `DISPUTED`, but §6.2's
  own state table never defines `RELEASE_PENDING` and only documents
  `UNDER_REVIEW`/`RESOLUTION_PROPOSED` as the resolution route. This implementation
  collapses the happy path straight from `REVIEW_PENDING` to `AWAITING_SIGNATURES`, and
  routes *both* seller ACCEPT and CONTEST through `UNDER_REVIEW` so every dispute
  produces a recorded arbitration outcome. Revisit if you want ACCEPT to skip arbitration.
- `backend/src/db.js` — schema rebuilt from PRD §10's table list (`participants`,
  `escrows`, `assessments`, `settlements`, `nostr_events`, `notifications` added beyond
  the PRD's list for in-app system messages).
- `backend/src/services/orderService.js` — rewritten around settlement proposals +
  2-of-3 signature collection instead of single-party disbursements. The idempotency
  pattern (unique `idempotency_key` per money-movement row) is the one structural idea
  carried over from LinkLock's `recordMoney`.
- `backend/src/routes/*.js` — new endpoints matching the new lifecycle
  (`/dispatch`, `/deliver`, `/confirm`, `/seller-response`, `/sign`, ...).
- Frontend pages (`Home`, `OrderPay`, `SellerWorkspace` — renamed from `VendorOrder`,
  `Console`) — rewritten field-by-field against the new API shape (`amountSats` not
  `amount`, `escrow.address` not a virtual bank account, pubkeys not bank accounts,
  settlements not transactions).

## UPDATE: Bitcoin + Nostr backend now implemented

`lib/bitcoin.js`, `lib/chain.js` and `lib/nostr.js` are real (see ROADMAP.md). Set
`BITCOIN_LIVE=true` + `ARBITRATOR_PUBKEY` for live mode; default remains simulation so the
current frontend keeps working. The "stubbed" notes below are historical.

## Explicitly stubbed — NOT implemented (historical)

- **`backend/src/lib/bitcoin.js`** — every export throws `BitcoinNotImplementedError`.
  Needs: a Bitcoin Core RPC client or Esplora-style indexer, a P2WSH 2-of-3 script
  builder, PSBT construction for release/refund/split, broadcast. See the file's header
  comment for the specific shape each function needs to return.
- **`backend/src/lib/nostr.js`** — every export throws `NostrNotImplementedError`. Needs
  an NDK (or similar) client against `config.nostr.relays`, NIP-17 private messaging,
  NIP-07 browser-signer integration on the frontend.
- **`config.bitcoinLive`** is hardcoded `false`. The entire backend runs in simulation
  mode (fake escrow addresses, fake txids, fake PSBTs) until someone flips this after
  wiring up `lib/bitcoin.js`. This mirrors exactly how LinkLock behaved when
  `MONNIFY_CONTRACT_CODE` was unset — same safety property (nothing in the state machine,
  AI layer, or dispute flow depends on which mode you're in).
- **`frontend/src/components/SigningPrompt.jsx`** — collects a pubkey + a freeform
  "signature" string and POSTs them. This is a placeholder for what should be a real
  wallet integration (browser extension wallet, or a NIP-07-style signer) that shows the
  actual PSBT outputs before signing. Says so in its own file header.
- **Per-arbitrator access control** (PRD §9: "arbitrator access must be restricted to
  assigned disputes") — the arbitration console still uses one shared `ADMIN_TOKEN`,
  same as LinkLock's review console. Fine for a hackathon demo, not for multiple
  arbitrators in production.

## Dropped, not ported

- **LinkLock's visual brand** (`Logo.jsx`'s padlock/chain-link SVG, the generated
  `hero-padlock.png` / `icon-*.png` assets, the golden-yellow identity) — this was
  LinkLock's own hackathon brand, not generic code. `Logo.jsx` now has a plain
  placeholder "seal" mark; design CoSeal's real identity separately. The Tailwind
  color tokens (`gold`, `ink`, `canvas`, etc.) were kept as a visual *system* since
  swapping a palette is cheap, but the hex values are still LinkLock's — change them
  before this ships anywhere real.
- **`scripts/cutout.mjs` / `scripts/gen_assets.mjs`** — LinkLock-brand-specific image
  generation one-offs, not reusable.
- **TypeScript.** PRD §11 specifies a TypeScript frontend; this port kept the frontend
  in plain JS/JSX (what LinkLock already had) to get a working scaffold quickly. If the
  TS requirement is load-bearing, the frontend needs a real migration, not a port.
- **Bank/account validation UI** (LinkLock's live name-enquiry-as-you-type flow) — no
  equivalent exists for pubkeys, so `Home.jsx`'s create form is just a plain text input
  for `sellerPubkey`/`buyerPubkey` with no validation.

## Verified end-to-end (in simulation mode)

Both lifecycle paths were run against the live backend API during this port:
1. Happy path: create → simulate-funding → dispatch → deliver → confirm → sign×2 → `RELEASED`.
2. Dispute path: create → fund → dispatch → deliver → dispute → seller CONTEST →
   arbitrator SPLIT → `AWAITING_SIGNATURES`.

The frontend build (`npm run build`) succeeds and the dev server boots, but the UI
itself was **not** click-tested in a browser (no browser automation tool was available
in this session) — treat the frontend as "compiles and the data flow should line up,"
not as "confirmed working in a real browser."
