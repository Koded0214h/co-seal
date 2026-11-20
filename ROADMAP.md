# CoSeal Roadmap — gap analysis and module breakdown

Baseline: LinkLock port (see `MIGRATION_NOTES.md`). Measured against `PRD.md` v0.2.
Effort sizes: S ≈ half a day, M ≈ 1 day, L ≈ 2+ days (one developer).

**Overall: backend ~85% of P0; frontend ~15% (still the LinkLock-port shell).**
Bitcoin escrow/settlement, Nostr references, audit chain and evidence verification are built and
tested against an in-memory chain. Not yet exercised on live Signet. Auth is deferred by decision.

## Module status (updated after backend build-out)

| # | Module | Status | Left |
|---|---|---|---|
| M1 Lifecycle | **backend done** | Agreement hash + buyer acceptance, buyer-join flow. Frontend flow redesign pending |
| M2 Bitcoin escrow | **backend done, untested on live Signet** | Sorted-key P2WSH 2-of-3, Esplora funding watcher (confirmations, dedupe, reorg flag), verifiable escrow. Needs a real Signet run (sandbox had no network). Browser wallet (keygen, QR, balance, PSBT sign) is frontend work |
| M3 Settlement | **backend done** | PSBT build/merge/finalize, per-scenario signer policy, atomic single broadcast, retry-safe. 17 tests |
| M4 Nostr | **backend refs done** | Event-reference store (sig-verified, idempotent), conversation tag, identity. NIP-07/NIP-17/44/59 DMs live in the frontend client (not built) |
| M5 Evidence & AI | mostly done | Hash re-verify endpoint, magic-byte validation, device-vs-server time. Left: structured output polish, reused-photo detection |
| M6 Arbitration | logic done | Per-arbitrator auth + assignment (deferred with auth work) |
| M7 Audit | **done** | Hash-chained events + DB triggers blocking UPDATE/DELETE; `GET /:ref/events` verifies chain |
| M8 Frontend | **not started** | Flow redesign, wallet, Nostr DMs, PSBT review, TS decision, branding |
| M9 Security/auth | deferred by decision | Authn/authz on all mutations, rate limits, log scrubbing |
| M10 Tests/demo/deploy | partial | 28 backend tests pass. Left: live Signet e2e script, seeded demo, Docker with env |
| M11 P1 | not started | |

## Open decisions

- **TypeScript**: PRD says TS; port is JS. Migrate now (cheap at ~3k LOC) or waive for the hackathon?
- **Bitcoin backend**: Esplora REST (recommended) vs. bitcoind RPC (as PRD text says).
- **`RELEASE_PENDING` / seller-ACCEPT path**: keep collapsed (current) or follow the §6.1 diagram.
- **Key custody in browser**: browser-generated Signet wallet (simplest for demo) vs. external signer.

## Known risks

- No auth on order mutation endpoints — anyone with a link can call them (deferred by decision).
- Simulation mode is the default; its txids/PSBTs are fake. Set `BITCOIN_LIVE=true` for real mode.
- Arbitrator uses one configured key for every order (buyer/seller keys must be per-order; enforced by a UNIQUE escrow address). Per-order arbitrator derivation from an xpub is a follow-up.
- Frontend never click-tested in a browser; no automated tests anywhere.
