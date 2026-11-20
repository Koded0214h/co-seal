# CoSeal Roadmap — gap analysis and module breakdown

Baseline: LinkLock port (see `MIGRATION_NOTES.md`). Measured against `PRD.md` v0.2.
Effort sizes: S ≈ half a day, M ≈ 1 day, L ≈ 2+ days (one developer).

**Overall: ~35–40% of the P0 scope exists, but almost none of the hard part.**
The app-shaped skeleton (state machine, order service, AI layer, evidence upload, pages) is
in place and runs in simulation mode. The three things that make CoSeal *CoSeal* —
Bitcoin escrow, Nostr messaging, real signing — are stubs.

## Module status

| # | Module | PRD | Status | Left | Size |
|---|---|---|---|---|---|
| M1 | Core lifecycle & state machine | §6, FR-01/05/06/07 | ~80% | Decide `RELEASE_PENDING` deviation; per-order buyer/seller auth; agreement acceptance + immutability; edits require new agreement | M |
| M2 | Bitcoin escrow & wallet | FR-02, FR-03 | ~5% (stubs throw) | P2WSH 2-of-3 builder (bitcoinjs-lib), Signet backend (Esplora or bitcoind RPC), funding watcher w/ confirmations + reorg + dedupe, PSBT builder, combine/finalize/broadcast, browser wallet (key gen, address+QR, balance, history, PSBT inspect+sign) | L ×2 |
| M3 | Settlement & idempotency | §6.3, §6.5 | ~50% (logic real, signatures fake) | Real PSBT partial signatures instead of freeform "signature"; validate outputs vs. approved proposal; enforce signer-role policy; reject duplicate broadcast | M |
| M4 | Nostr identity & messaging | FR-09 | ~0% (stub) | NDK, NIP-07 signer + generated-key fallback, NIP-17/44/59 DMs, order-linked conversations, `nostr_events` refs, notifications | L |
| M5 | Evidence & AI assessment | FR-04/10, §8 | ~75% | Hash-recompute verify endpoint, original preservation, server vs. device timestamps, structured output with confidence/evidence IDs, docs support, reused-photo detection | M |
| M6 | Dispute & arbitration | FR-06/07/08 | ~60% | Per-arbitrator auth (replace shared `ADMIN_TOKEN`), assigned-dispute scoping, arbitrator PSBT signing, Nostr refs in console | M |
| M7 | Audit / event log | FR-11 | ~60% | Enforce append-only (DB triggers), hash-chain events, attach sigs/Nostr refs, public history view | S |
| M8 | Frontend | §11, §12 | ~50% | Wire to real wallet/Nostr, PSBT review screen, Signet banner, mobile pass, TypeScript migration (PRD requires TS; port is JS), real CoSeal brand (placeholder logo, LinkLock palette) | L |
| M9 | Security & auth | §9 | ~15% | Authz on all order mutations (only admin routes are guarded today), upload validation, log scrubbing, rate limits | M |
| M10 | Tests, demo, deploy | §14, §15 | 0% | No tests exist. State-machine + idempotency tests, Signet e2e script, seeded 3-min demo, Docker, docs | M |
| M11 | P1 (later) | §13 | 0% | Nostr notifications, partial-split UI, milestones, i18n, developer API | — |

## Recommended build order

1. **M2 escrow + funding** — critical path; every demo-visible step depends on real Signet funding. Prefer an Esplora-style REST backend (mempool.space signet) over running bitcoind: far less ops.
2. **M3 + M2 PSBT** — real release/refund end to end on Signet.
3. **M9 minimal auth** — per-order participant auth before M6.
4. **M4 Nostr** — parallelisable with 2–3.
5. **M6 / M7 / M5 gaps**, then **M8** polish + TS decision, then **M10** demo hardening.

## Open decisions

- **TypeScript**: PRD says TS; port is JS. Migrate now (cheap at ~3k LOC) or waive for the hackathon?
- **Bitcoin backend**: Esplora REST (recommended) vs. bitcoind RPC (as PRD text says).
- **`RELEASE_PENDING` / seller-ACCEPT path**: keep collapsed (current) or follow the §6.1 diagram.
- **Key custody in browser**: browser-generated Signet wallet (simplest for demo) vs. external signer.

## Known risks

- No auth on order mutation endpoints — anyone with a link can call them.
- `bitcoinLive` is hardcoded `false`; simulated txids/PSBTs could be mistaken for real.
- Frontend never click-tested in a browser; no automated tests anywhere.
