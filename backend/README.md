# CoSeal backend

Express + SQLite API: non-custodial 2-of-3 Bitcoin escrow, Nostr-identity auth with RBAC, AI-assisted
evidence assessment, hash-chained audit log. Node ≥ 22.5 (uses `node:sqlite`).

```bash
npm install
cp .env.example .env        # fill in what you need
npm start                   # simulation mode by default
npm test                    # 84 tests (unit + HTTP + real-node e2e if bitcoind is found)
npm run test:unit           # everything except the bitcoind e2e
npm run test:e2e            # only the real Bitcoin Core regtest e2e
```

## Full user-flow simulation

A narrated walkthrough of every role through the real HTTP API (login, roles, escrow, dispatch, dispute, arbitration, signing, settlement, audit, admin view):

```bash
npm run simulate                      # simulation mode, no node needed (4 scenarios, ~60 checks)
npm run regtest -- start && npm run simulate:regtest   # same journey on a REAL Bitcoin Core node
npm run simulate:signet               # PUBLIC Signet: prints an escrow address, you fund it from a faucet
```
Scenarios: `--scenario happy | accept | split | timeout | all`. Exit code is non-zero on any failed check.

## Modes

| Mode | Set | Behaviour |
|---|---|---|
| Simulation (default) | nothing | Fake escrow address/funding/txids. Still fully authenticated + role-checked. |
| Live | `BITCOIN_LIVE=true` + `ARBITRATOR_PUBKEY` (or register arbitrators) | Real P2WSH 2-of-3 escrow, chain-verified funding, real PSBT signing and broadcast. |

Chain backend (`BITCOIN_CHAIN`): `esplora` (default; `BITCOIN_ESPLORA_URL`, e.g. mempool.space Signet) or
`rpc` (Bitcoin Core watch-only wallet; `BITCOIN_RPC_URL/USER/PASSWORD`, no keys ever stored in the node).

### Try it against a real node (regtest)

```bash
npm run regtest -- start && npm run regtest -- mine 1
BITCOIN_LIVE=true BITCOIN_NETWORK=regtest BITCOIN_CHAIN=rpc BITCOIN_RPC_URL=http://127.0.0.1:18443 \
BITCOIN_RPC_USER=coseal BITCOIN_RPC_PASSWORD=coseal ADMIN_PUBKEYS=<your nostr pubkey hex> npm start
npm run regtest -- fund <escrow address> 100000 && npm run regtest -- mine 1
```

## Auth & RBAC

No passwords or accounts to create. A user **is** a Nostr pubkey that signs a one-time challenge (NIP-07 compatible):

1. `POST /api/auth/challenge` → `{ nonce, kind: 22242 }`
2. Sign an event `{ kind: 22242, tags: [["challenge", nonce]], created_at: now }`
3. `POST /api/auth/login { event }` → `{ token, user }` (opaque bearer token, stored hashed, 24h TTL)

| Global role | Can |
|---|---|
| `USER` | create orders (becomes **SELLER**), join orders (becomes **BUYER**), `/api/me*` |
| `ARBITRATOR` | resolve disputes **assigned to them**; `/api/arbitrator/queue` |
| `ADMIN` | `/api/admin/*` users, arbitrators, stats; acts as arbitrator on unassigned orders |

Bootstrap the first admin with `ADMIN_PUBKEYS`. Admins register arbitrators (`POST /api/admin/arbitrators {nostrPubkey, btcPubkey}`):
the arbitrator's escrow key is assigned per order at creation. Per-order roles (SELLER/BUYER/ARBITRATOR) are derived from the order,
and every audit event records who acted. Suspending a user kills their sessions immediately.

## Lifecycle & money safety

`CREATED → AWAITING_FUNDING → FUNDED → DISPATCHED → (IN_TRANSIT) → DELIVERED → REVIEW_PENDING → …`
buyer confirms → release PSBT (buyer+seller) · buyer disputes → seller **ACCEPT** → refund PSBT (buyer+seller) or **CONTEST** →
arbitrator `RELEASE | REFUND | SPLIT(sellerShareBps)` (arbitrator + the relevant party).

- Backend never holds keys. It builds unsigned PSBTs; participants sign in their own wallets; the server verifies the PSBT is exactly the proposed transaction, every signature is valid, the signer's key belongs to the authenticated user's role, and the role policy allows it — then broadcasts once.
- Funding is read from the chain (confirmations policy, multi-UTXO, reorg detection). Settlements spend every confirmed escrow output.
- AI never moves money (`money_movement_authorized` is always false) and never blocks: provider failure ⇒ `AI_PROVIDER_UNAVAILABLE`, flow continues.
- No backend timer spends funds: an expired review window escalates to arbitration.
- `GET /api/orders/:ref/events` returns the hash-chained audit trail (DB triggers make it append-only).

## AI provider (adapters in `src/lib/llm`)

`LLM_PROVIDER=openai` (default; `OPENAI_API_KEY`, model `gpt-5-nano`) or `anthropic` (`ANTHROPIC_API_KEY`, model `claude-haiku-5-5`).
Override the model with `LLM_MODEL`; verify the name against your account. Add a provider by implementing
`complete({system, prompt, images}) → {ok, data | reason}`. A deterministic perceptual-hash reuse check runs even when no provider is configured.

## Known limits

- Live Signet (public network) has not been exercised — regtest on a real Bitcoin Core node has.
- No fee-bump flow for a stuck settlement (inputs are RBF-signalling); a dropped settlement is flagged (`SETTLEMENT_NOT_FOUND`).
- One configured arbitrator key per arbitrator (reused across their orders; buyer/seller keys must be unique per order).
- Evidence storage is local disk; use object storage for deployment.
