# CoSeal
## Product Requirements Document

**Version:** 0.2  
**Status:** Hackathon MVP  
**Event:** Dakar Bitcoin Hack by BTrust  
**Date:** November 20, 2026  
**Category:** Bitcoin · Lightning · Nostr · AI  
**Tagline:** Deals, sealed by both sides.

---

## 1. Product overview

CoSeal is an open-source, Bitcoin-powered transaction assurance layer that helps buyers and sellers transact with strangers without relying solely on mutual trust.

A seller creates a transaction and shares a unique link with a buyer. The link contains the order details, agreed terms, delivery requirements and escrow conditions.

The buyer opens the link, reviews the agreement and funds the transaction through Bitcoin.

Funds are locked in an isolated, order-specific 2-of-3 multisignature escrow. They can only be spent when the required participants sign a valid settlement transaction.

CoSeal combines three technologies:

- **Bitcoin:** Non-custodial, per-order escrow and settlement.
- **Nostr:** Portable identities and private communication.
- **AI:** Evidence assessment, package-image comparison and dispute assistance.

CoSeal is not a marketplace, conventional fintech application or custodial wallet. It coordinates agreements, communication, evidence and settlement while leaving control of funds with the participants.

### Core proposition

One link to establish an agreement. Bitcoin to protect the money. Nostr to communicate. AI to help evaluate the evidence.

---

## 2. Problem statement

Social commerce and informal trade frequently happen through messaging applications, social networks and direct relationships.

A vendor sends an account number or payment address, and the buyer sends money based on trust. In many cases, neither party has a reliable mechanism for protecting themselves when something goes wrong.

Buyers risk:
- Paying for goods that are never delivered.
- Receiving counterfeit, incorrect or damaged products.
- Losing money to fraudulent vendors.
- Having limited evidence when attempting to resolve disputes.

Sellers risk:
- Dispatching products without receiving payment.
- Dishonest buyers claiming non-delivery.
- Buyers retaining goods while requesting refunds.
- Having limited protection against fraudulent disputes.

Existing payment systems facilitate the movement of money, but they do not necessarily establish trust between participants or provide a fair, verifiable transaction-resolution process.

The problem becomes more complicated across borders, where participants may operate in different countries, use fragmented communication channels and encounter different commercial practices.

**CoSeal addresses the gap between payment settlement and trustworthy commerce.**

## 3. Product thesis

### 3.1 Link-first commerce

CoSeal removes unnecessary onboarding friction.

A shareable transaction link is the primary entry point. Buyers and sellers do not need to create conventional CoSeal accounts before participating.

They connect their Bitcoin wallets and Nostr identities when required.

The link provides access to the agreement, payment status, evidence, communication and transaction history.

A link is not itself a payment credential or authority to spend escrow funds.

### 3.2 Isolated escrow

**CoSeal never pools transaction funds.**

Every transaction has its own Bitcoin multisignature escrow arrangement.

CoSeal does not possess unilateral control over buyer or seller funds. The application coordinates transaction creation, monitoring, signing and settlement but cannot independently spend the escrow.

### 3.3 Deterministic transaction lifecycle

Money movement must follow an explicit, guarded state machine.

Every significant state transition and settlement operation must be recorded.

Repeated requests, duplicated blockchain observations or retried settlement operations must not result in duplicate financial movements.

### 3.4 Evidence-based dispute resolution

CoSeal combines evidence submitted by both transaction participants with AI-assisted analysis.

The AI identifies potential inconsistencies and provides structured assessments to support human review.

**AI never independently authorizes a refund, release or other settlement.**

### 3.5 Disputes must not depend on AI availability

When a buyer raises a legitimate dispute, the application immediately marks the order as disputed and prevents normal settlement from proceeding.

This happens before AI analysis begins.

If the AI provider is unavailable, the dispute can still be resolved through human review.

---

## 4. Goals and non-goals

### Goals

- No mandatory conventional CoSeal account registration.
- Shareable transaction links as the primary user interface.
- Non-custodial, order-specific Bitcoin escrow.
- Actual Bitcoin wallet and Signet integration.
- Private buyer-seller communication using Nostr.
- AI-assisted evidence verification and comparison.
- Human-accountable dispute resolution.
- Deterministic, auditable transaction state transitions.
- Idempotent settlement operations.
- Graceful degradation when external services become unavailable.
- Mobile-first design suitable for users with limited bandwidth.

### Non-goals for the hackathon MVP

- Mainnet financial deployment.
- Custodial wallet functionality.
- Pooled buyer or seller balances.
- Fiat deposits and withdrawals.
- Fiat-to-crypto exchange services.
- Currency conversion and foreign exchange liquidity.
- Marketplace discovery or product listings.
- Multi-item shopping carts.
- Automated legal arbitration.
- Autonomous AI-controlled settlement.
- Fully automated timeout-based fund release without an appropriate Bitcoin script.
- Production deployment of an arbitrator's signing infrastructure.

The MVP targets Bitcoin Signet. It may be designed with cross-border commerce in mind, but it will not claim to provide a complete regulated cross-border payment network.

---

## 5. Users and personas

| Persona | Needs | Primary interface |
|---|---|---|
| Buyer | Pay safely, inspect terms, monitor delivery and dispute problematic transactions | Buyer transaction page |
| Seller | Create agreements, share payment links, prove dispatch and receive payment | Seller workspace |
| Arbitrator | Review contested transactions and coordinate a fair settlement | Arbitration console |
| Developer / integrator | Integrate CoSeal's transaction assurance capabilities into another commerce application | API and documentation |

### Buyer

A person purchasing goods from someone they do not necessarily know or trust.

The buyer must be able to inspect the agreement, fund escrow, communicate with the seller, monitor delivery and confirm or dispute the outcome.

### Seller

An individual or business fulfilling an order.

The seller must be able to create an order, share a link, verify escrow funding, submit dispatch evidence and receive funds after successful settlement.

### Arbitrator

A designated neutral participant involved in resolving disputes.

The arbitrator reviews the original agreement, participant evidence and relevant transaction history before participating in the settlement process.

---

## 6. Core transaction lifecycle

The state machine is the source of truth for the application.

No participant or backend service can arbitrarily move an order into an invalid state.

### 6.1 State machine

```text
CREATED
   |
   | Agreement generated
   v
AWAITING_FUNDING
   |
   | Bitcoin funding detected and verified
   v
FUNDED
   |
   | Seller submits dispatch evidence
   v
DISPATCHED
   |
   | Tracking / shipping updates
   v
IN_TRANSIT
   |
   | Delivery reported
   v
DELIVERED
   |
   v
REVIEW_PENDING
   |
   +---------------------------+
   |                           |
   | Buyer confirms            | Buyer disputes
   v                           v
RELEASE_PENDING             DISPUTED
   |                           |
   |                           | Vendor accepts
   |                           | or contests
   |                           v
   |                      UNDER_REVIEW
   |                           |
   |                           | Human resolution
   |                           v
   |                   RESOLUTION_PROPOSED
   |                           |
   +---------------------------+
               |
               v
       AWAITING_SIGNATURES
               |
       +-------+-------+
       |       |       |
       v       v       v
    RELEASED REFUNDED SPLIT
```

### 6.2 State definitions

| State | Meaning |
|---|---|
| `CREATED` | Initial transaction record has been generated. |
| `AWAITING_FUNDING` | Agreement exists and escrow funding is pending. |
| `FUNDED` | Bitcoin funding has been independently detected and verified according to the configured confirmation policy. |
| `DISPATCHED` | Seller has submitted and acknowledged dispatch evidence. |
| `IN_TRANSIT` | Order is being transported. |
| `DELIVERED` | Delivery has been reported. |
| `REVIEW_PENDING` | Buyer has an opportunity to inspect the goods. |
| `DISPUTED` | Buyer has raised an objection; normal settlement is suspended. |
| `UNDER_REVIEW` | The dispute is being examined by the designated arbitrator. |
| `RESOLUTION_PROPOSED` | A settlement outcome has been recorded. |
| `AWAITING_SIGNATURES` | The corresponding Bitcoin settlement transaction is awaiting required signatures. |
| `RELEASED` | Funds have been released to the seller. |
| `REFUNDED` | Funds have been returned to the buyer. |
| `SPLIT` | Funds have been distributed between the parties. |

### 6.3 Settlement rules

CoSeal uses an order-specific 2-of-3 multisignature arrangement.

The keys belong to:

1. Buyer.
2. Seller.
3. Arbitrator.

The normal transaction path uses buyer and seller cooperation.

A contested transaction uses the arbitrator as a participating signer in the agreed resolution process.

| Scenario | Settlement policy |
|---|---|
| Buyer confirms successful delivery | Buyer and seller sign release |
| Buyer and seller agree to a refund | Buyer and seller sign refund |
| Arbitrator resolves in seller's favour | Seller and arbitrator sign release |
| Arbitrator resolves in buyer's favour | Buyer and arbitrator sign refund |
| Agreed partial settlement | Appropriate signers authorise a split transaction |

A standard 2-of-3 multisig script permits any two of the three keys to sign. It does not independently enforce role-specific dispute policies. The application must therefore present and validate settlement proposals, while every signer independently verifies the PSBT outputs before signing.

### 6.4 Default-release and timeout handling

A buyer who does not respond after delivery must not be allowed to hold the seller's money indefinitely.

However, a backend timer cannot independently spend a Bitcoin multisignature output.

For the MVP, expired review windows are escalated through the transaction-resolution workflow. Funds remain locked until a valid settlement is signed.

A future default-release mechanism must be implemented through an appropriate pre-agreed Bitcoin script and timelock arrangement, rather than a backend-only timer.

### 6.5 Idempotency

Every financial operation must have a deterministic, unique reference.

Examples:

- `{orderId}-FUNDING`
- `{orderId}-RELEASE`
- `{orderId}-REFUND`
- `{orderId}-SPLIT`

Duplicate API requests, repeated transaction observations and retry operations must not generate duplicate settlement transactions.

The backend records each settlement proposal, PSBT, signing event and broadcast transaction.

---

## 7. Functional requirements

### FR-01: Transaction creation

A seller must be able to create a transaction containing:

- Product or service name.
- Description.
- Optional product reference images.
- Amount denominated in satoshis.
- Seller identity.
- Optional buyer identity.
- Delivery conditions.
- Expected delivery date.
- Inspection window.
- Dispute terms.
- Arbitrator public key.

The application generates:

- Unique transaction ID.
- Shareable transaction URL.
- Bitcoin escrow arrangement.
- Transaction agreement.

Agreed terms become immutable once accepted by both parties. Changes require a new agreement explicitly acknowledged by both participants.

The transaction link must not grant anyone the ability to spend escrow funds.

### FR-02: Bitcoin wallet and escrow

CoSeal must implement a functional Bitcoin wallet experience using Signet.

MVP capabilities:

- Connect or create a supported testnet wallet.
- Display wallet address.
- Display available balance.
- Generate receiving addresses and QR codes.
- Display transaction history.
- Create, inspect and sign PSBTs.
- Broadcast valid settlement transactions.
- Independently verify funding and settlement status.

Every order receives an isolated 2-of-3 Bitcoin multisignature escrow arrangement.

The application must not store participant private keys or expose them to the backend.

Escrow addresses and scripts must be independently verifiable.

Funding status must be determined from actual Bitcoin transactions, not frontend payment confirmations.

### FR-03: Payment monitoring

The backend monitors Bitcoin transactions associated with active escrow outputs.

Requirements:

- Detect funding transactions.
- Identify the relevant transaction output.
- Verify the escrow script and amount.
- Track mempool and confirmation status.
- Handle duplicate blockchain observations.
- Detect and appropriately handle transaction reorganisations.
- Record transaction IDs and confirmation information.

A transaction cannot enter `FUNDED` until the configured funding verification policy has been satisfied.

The hackathon environment uses Signet and clearly communicates testnet status.

### FR-04: Seller dispatch

The seller submits dispatch evidence.

Supported evidence includes:

- Product photographs.
- Packaging photographs.
- Shipping labels.
- Delivery reference numbers.
- Shipping documents.
- Dispatch photographs.

The AI assessment checks submitted evidence against the transaction description and available product information.

When AI identifies a potential problem, the seller receives an explanation and can acknowledge the warning.

AI must not permanently prevent an otherwise valid transaction from progressing.

If the provider is unavailable, the application records the assessment as unavailable and allows the workflow to continue.

### FR-05: Delivery and buyer confirmation

The seller reports that the product has been delivered.

The buyer receives a transaction notification and can:

- Confirm successful receipt.
- Report an incorrect product.
- Report damaged or missing goods.
- Report suspected fraud.
- Submit supporting evidence.

The buyer's ability to dispute must not depend on AI availability.

### FR-06: Dispute creation

A buyer can raise a dispute containing:

- Dispute category.
- Description.
- Optional photographs.
- Supporting documents.
- Relevant transaction references.

On dispute creation:

1. The transaction enters `DISPUTED`.
2. Normal release operations are suspended.
3. Relevant evidence is preserved.
4. The seller is notified.
5. AI comparison is initiated when available.

Funds remain in their Bitcoin escrow arrangement.

### FR-07: Vendor dispute response

The seller can:

- ACCEPT the buyer's claim.
- CONTEST the buyer's claim.

Acceptance records the agreement to resolve the transaction through a refund.

Contesting escalates the transaction to human arbitration.

Neither response independently moves Bitcoin funds.

### FR-08: Human arbitration

The arbitrator receives access to:

- Original transaction agreement.
- Buyer evidence.
- Seller evidence.
- AI assessment.
- Communication references relevant to the dispute.
- Transaction event history.

The arbitrator can propose:

- Full release.
- Full refund.
- Partial settlement.

The proposal must be reviewed and signed according to the agreed multisignature arrangement.

AI assessments are advisory and cannot replace human review.

### FR-09: Nostr communication

Buyers and sellers must be able to communicate within their transaction environment using Nostr.

Required capabilities:

- Nostr public-key identity.
- Private direct messages.
- Transaction-linked conversations.
- Message timestamps.
- Event references.
- Transaction notifications.

Preferred protocol specifications:

- NIP-01: Basic Nostr events.
- NIP-07: Browser signer integration.
- NIP-17: Private messaging.
- NIP-44: Encrypted message payloads.
- NIP-59: Gift-wrapped events.

The application should store message references and the minimum required metadata rather than making its database the authoritative owner of private conversations.

### FR-10: AI evidence verification

The AI layer evaluates transaction evidence and identifies potential inconsistencies.

Assessment categories:

- Product mismatch.
- Packaging inconsistency.
- Suspicious or reused photographs.
- Dispatch evidence inconsistency.
- Delivery evidence inconsistency.
- Missing or insufficient evidence.
- Potentially contradictory claims.

The AI returns structured output containing:

- Transaction ID.
- Evidence identifiers.
- Assessment category.
- Findings.
- Severity.
- Confidence description.
- Recommendation.
- Human-review requirement.

The AI must explain the basis of its observations and communicate uncertainty.

It cannot establish physical proof of package contents from an exterior photograph alone.

**The AI never directly authorises the movement of money.**

### FR-11: Verifiable transaction history

Every transaction maintains an append-only application event history.

Events include:

- Transaction creation.
- Agreement acceptance.
- Escrow generation.
- Funding detection.
- Funding confirmation.
- Dispatch evidence submission.
- Shipping updates.
- Delivery reporting.
- Buyer confirmation or dispute.
- AI assessment.
- Arbitrator decisions.
- PSBT creation.
- Participant signatures.
- Transaction broadcast.
- Settlement confirmation.

Where appropriate, events include cryptographic signatures, hashes or Nostr event references.

Private information must not be exposed through public blockchain records.

---

## 8. AI verification architecture

The AI provider should use a vision-capable model accessible through a configurable API.

Images should be validated, resized and compressed before inference.

Each assessment must be associated with its source evidence and transaction.

Example response:

```json
{
  "transaction_id": "CS-ORDER-ID",
  "assessment": "REVIEW_REQUIRED",
  "findings": [
    {
      "category": "PRODUCT_MISMATCH",
      "severity": "HIGH",
      "description": "The received item appears visually different from the original listing."
    }
  ],
  "recommendation": "HUMAN_REVIEW",
  "money_movement_authorized": false
}
```

### Graceful degradation

Every AI request must be isolated from the core transaction lifecycle.

If the provider fails because of:

- Rate limits.
- Invalid model configuration.
- Timeouts.
- Malformed responses.
- Provider outages.
- Network connectivity issues.

The application records:

```json
{
  "available": false,
  "reason": "AI_PROVIDER_UNAVAILABLE"
}
```

Evidence submission and dispute creation must continue to work.

AI failure must never cause funds to be released, refunded or lost.

---

## 9. Security and privacy requirements

- Bitcoin private keys must never be stored by the backend.
- Participant signing must occur in an appropriate wallet environment.
- Each order must have its own multisignature escrow arrangement.
- Wallet secrets must never appear in application logs.
- Every settlement must follow a valid transaction-state transition.
- PSBT outputs must be displayed for participant review before signing.
- Uploaded files must be validated by content type and size.
- Original evidence must be preserved.
- Evidence hashes must be calculated from original uploaded bytes.
- Server-received timestamps must be distinguished from unverified device capture timestamps.
- Private Nostr messages must use the intended encryption protocols.
- AI providers must receive only the evidence and context necessary for an assessment.
- Public blockchain transactions must not include sensitive personal or commercial information.
- All API mutations must be authenticated and authorised.
- Arbitrator access must be restricted to assigned disputes.

A SHA-256 file hash establishes content integrity relative to a known hash. It does not independently prove the photograph's capture date or the truth of its contents.

---

## 10. Data model

SQLite is the MVP database.

Recommended tables:

| Table | Purpose |
|---|---|
| `orders` | Transaction information, agreed terms, participants and current state |
| `participants` | Buyer, seller and arbitrator public-key references |
| `escrows` | Scripts, addresses, key references and escrow configuration |
| `evidence` | Original file references, SHA-256 hashes, evidence categories and timestamps |
| `assessments` | AI findings and assessment availability |
| `disputes` | Dispute reasons, seller responses and resolution status |
| `settlements` | Settlement proposals, PSBTs, signatures and broadcast references |
| `transactions` | Bitcoin funding and settlement transaction records |
| `nostr_events` | Event references and relevant transaction-message metadata |
| `events` | Append-only transaction activity and state transitions |

Financial records must be uniquely keyed to their originating transaction and operation.

---

## 11. Technical architecture

### Frontend
- React.
- Vite.
- TypeScript.
- Tailwind CSS.
- Mobile-first responsive layouts.

### Backend
- Node.js.
- Express.
- SQLite.
- REST API.

### Bitcoin
- Bitcoin Core.
- Bitcoin Signet.
- P2WSH 2-of-3 multisignature scripts.
- PSBT transaction construction and signing.
- Bitcoin Core RPC and descriptor wallets.
- Transaction and confirmation monitoring.

### Nostr
- Nostr Development Kit (NDK) or compatible library.
- Nostr relays.
- NIP-17 private messaging.
- Browser signer integration.

### AI
- Vision-capable language model.
- Groq or compatible inference provider.
- Structured JSON responses.
- Evidence comparison and assessment.

### Evidence storage
- Local storage for development.
- Object storage for deployment.
- SHA-256 content verification.

### Logical architecture

```text
                 BUYER / SELLER
                       |
                       v
                COSEAL FRONTEND
                       |
          +------------+------------+
          |            |            |
          v            v            v
         API          NOSTR       BITCOIN
          |           RELAYS       SIGNET
          |            |            |
          v            v            v
       DATABASE     PRIVATE       MULTISIG
       + EVENTS     MESSAGES      ESCROW
          |
     +----+------+
     |           |
     v           v
  EVIDENCE       AI
  STORAGE      SERVICE
     |           |
     +-----+-----+
           |
      ARBITRATION
        CONSOLE
           |
           v
      PSBT SIGNING
           |
           v
    BITCOIN SETTLEMENT
```

---

## 12. Non-functional requirements

### Idempotency
Repeated funding observations, webhook deliveries, API requests and settlement attempts must not produce duplicate financial operations.

### Reliability
AI and Nostr service outages must not corrupt transaction records or prevent access to previously submitted evidence.

### Security
No backend endpoint should be able to independently sign or spend participant funds.

### Auditability
All critical transitions and financial operations must be traceable to their originating actions and transaction references.

### Performance
Transaction pages should remain usable on mid-range mobile phones and slower network connections.

### Accessibility
The interface must use clear language, readable typography, accessible controls and understandable transaction status indicators.

### Maintainability
The Bitcoin, Nostr and AI integrations should be isolated behind service modules so that providers can be replaced without rewriting the core transaction lifecycle.

---

## 13. MVP scope and delivery priorities

### P0 — Essential

- [ ] Transaction creation.
- [ ] Shareable transaction links.
- [ ] Buyer and seller transaction views.
- [ ] Bitcoin Signet wallet integration.
- [ ] Order-specific 2-of-3 multisig escrow.
- [ ] Real Bitcoin funding detection.
- [ ] PSBT-based release and refund.
- [ ] Transaction state machine.
- [ ] Idempotent financial operations.
- [ ] Evidence upload and SHA-256 verification.
- [ ] AI evidence assessment.
- [ ] Dispute creation and arbitration.
- [ ] Nostr identity and private messaging.
- [ ] Append-only event history.
- [ ] Complete working demonstration.

### P1 — Additional improvements

- [ ] Nostr notifications.
- [ ] Partial settlements.
- [ ] Multiple shipping milestones.
- [ ] Richer evidence comparison.
- [ ] Multiple language support.
- [ ] Portable reputation and commercial attestations.
- [ ] Developer integration API.

### Explicitly deferred

- Bitcoin mainnet deployment.
- Custodial wallet features.
- Fiat settlement.
- Exchange-rate and FX services.
- Automated timeout-release scripts.
- Multiple cryptocurrency networks.
- Production arbitration infrastructure.

---

## 14. Acceptance criteria

The MVP is considered functional when:

### Transaction creation
- A seller can create an order.
- A unique shareable URL is generated.
- A buyer can access and inspect the agreement.
- Agreed terms are preserved.

### Bitcoin escrow
- A unique multisignature escrow is generated.
- Participants can verify its configuration.
- A buyer can fund it using Signet BTC.
- Funding is independently verified.
- The transaction cannot be represented as funded merely because a frontend button was clicked.

### Communication
- Buyer and seller have usable Nostr identities.
- They can exchange private transaction-related messages.
- Message references are associated with the correct transaction.

### Evidence and AI
- Both parties can submit evidence.
- Evidence hashes can be independently recalculated.
- AI can analyse submitted images.
- AI findings can be presented in the transaction room.
- AI failure does not prevent submission or dispute resolution.
- AI cannot execute a financial settlement.

### Arbitration
- A buyer can raise a dispute.
- The seller can respond.
- An arbitrator can inspect evidence.
- A valid settlement proposal can be generated.
- Required participants can sign the PSBT.

### Settlement
- The completed transaction can be broadcast.
- Its transaction ID can be independently verified.
- The application records the final outcome.
- Repeated settlement requests cannot create duplicate payments.

---

## 15. Three-minute demonstration

### 0:00–0:30 — The problem

Demonstrate the trust problem between a buyer and seller who do not know each other.

Introduce CoSeal and its shareable transaction-link approach.

### 0:30–1:00 — Create and fund

The seller creates an order.

The buyer opens the generated link, reviews the agreement and funds the Bitcoin escrow.

Show the actual Signet transaction.

### 1:00–1:35 — Communication and dispatch

The seller submits package evidence.

AI analyses the submission.

The buyer and seller exchange private Nostr messages.

### 1:35–2:20 — Dispute

The buyer submits contradictory delivery evidence.

The AI identifies inconsistencies and recommends human review.

The arbitrator examines the evidence and proposes a resolution.

### 2:20–2:50 — Settlement

The participants inspect and sign the settlement PSBT.

The resulting Bitcoin transaction is broadcast and verified.

### 2:50–3:00 — Closing

**CoSeal. Deals, sealed by both sides.**

---

## 16. Future direction

CoSeal should evolve beyond a standalone application into an open transaction-assurance protocol.

Potential capabilities include:

- Additional Bitcoin and Lightning transaction arrangements.
- Portable commercial identities.
- Verifiable trader and merchant attestations.
- Integration with logistics and delivery providers.
- Cross-border commercial agreements.
- Independent arbitration providers.
- Support for multiple African languages.
- Developer APIs for marketplaces and commerce applications.

The long-term vision is to make CoSeal's agreement, evidence, communication and settlement infrastructure reusable by other applications without requiring them to build their own trust systems.

---

## 17. Product definition

**CoSeal is an open-source, Bitcoin-powered transaction assurance layer that combines non-custodial multisignature escrow, Nostr communication and AI-assisted evidence assessment to make peer-to-peer commerce more trustworthy.**

One link. Both sides protected.
