# CoSeal Roadmap — gap analysis and module breakdown

Baseline: LinkLock port (see `MIGRATION_NOTES.md`). Measured against `PRD.md` v0.2.
Effort sizes: S ≈ half a day, M ≈ 1 day, L ≈ 2+ days (one developer).

**Overall: backend feature-complete and tested (84 tests, incl. real Bitcoin Core regtest). Frontend not started.**

## Module status

| # | Module | Status | Left |
|---|---|---|---|
| M1 Lifecycle | done | Seller ACCEPT→refund, amendments/terms edit, agreement hash |
| M2 Bitcoin escrow | done, verified on **real bitcoind regtest** | Not yet run on public Signet (needs your Esplora/RPC node). Browser wallet = frontend |
| M3 Settlement | done | Multi-UTXO, RBF-signalling, 3→2 signature trimming (validated by Core), arbitrator-set split. No fee-bump flow |
| M4 Nostr | backend refs done | NIP-07/17/44/59 client = frontend |
| M5 Evidence & AI | done | Provider adapters (OpenAI gpt-5-nano default, Claude Haiku optional), PRD-shaped findings, PDF + multi-file, perceptual-hash reuse detection |
| M6 Arbitration | done | Per-order arbitrator assignment, role-bound signing |
| M7 Audit | done | Hash chain + append-only triggers + actor on every event |
| M8 Frontend | **not started** | New flow with login, join, wallet/PSBT signing, Nostr DMs; old pages target the pre-auth API and will not work as-is |
| M9 Auth/RBAC/security | done | Nostr-signed login, sessions, USER/ARBITRATOR/ADMIN, per-order roles, private evidence, rate limits, log redaction |
| M10 Tests/deploy | mostly | Docker for live mode + object storage |
| M11 P1 | not started | Nostr notifications, milestones, i18n, dev API |

## Open decisions

- **TypeScript**: PRD says TS; port is JS. Migrate now (cheap at ~3k LOC) or waive for the hackathon?
- **Bitcoin backend**: Esplora REST (recommended) vs. bitcoind RPC (as PRD text says).
- **`RELEASE_PENDING` / seller-ACCEPT path**: keep collapsed (current) or follow the §6.1 diagram.
- **Key custody in browser**: browser-generated Signet wallet (simplest for demo) vs. external signer.

## Known risks

- Simulation mode is the default; its txids/PSBTs are fake. Set `BITCOIN_LIVE=true` for real mode.
- An arbitrator's escrow key is reused across their orders (buyer/seller keys must be unique per order; enforced by a UNIQUE escrow address). Per-order derivation from an xpub is a follow-up.
- Frontend never click-tested in a browser; no automated tests anywhere.
