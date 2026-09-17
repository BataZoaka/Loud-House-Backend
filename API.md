# The Loud House API — Integration Guide

Every request and response below was captured from a running server, not written
from memory. Status codes, field names and error shapes are what you will
actually receive.

- **Base URL (dev):** `http://localhost:4000/api`
- **Swagger (dev):** `http://localhost:4000/api/docs`
- **Content type:** `application/json`

---

## Contents

1. [How auth works](#1-how-auth-works)
2. [Conventions](#2-conventions-pagination-errors-dates)
3. [Auth endpoints](#3-auth)
4. [Collection endpoints](#4-collection)
5. [Staking endpoints](#5-staking)
6. [Raffle endpoints](#6-raffles)
7. [Operator endpoints](#7-operator-admin-only)
8. [End-to-end script](#8-end-to-end-script)
9. [Frontend integration notes](#9-frontend-integration-notes)

---

## 1. How auth works

Sign-In-With-Ethereum (EIP-4361), in two calls. The user proves they control a
wallet by signing a message; you get a JWT back and send it as a bearer token.

```
  ┌── GET /auth/nonce?address=0x… ──────────────────► returns { nonce, message }
  │
  ├── wallet signs `message`  (wagmi useSignMessage / viem signMessage)
  │
  ├── POST /auth/verify { message, signature } ─────► returns { accessToken, user }
  │
  └── every later call:  Authorization: Bearer <accessToken>
```

**Do not build the message yourself.** `/auth/nonce` returns the exact EIP-4361
string to sign. Assembling it on the frontend is the most common cause of
`signature verification failed` — one wrong field (domain, chain id, timestamp
format) and verification fails.

Three things to know:

- **A signature is single-use.** The nonce rotates on every successful login, so
  replaying the same signature returns `401`.
- **The nonce expires after 10 minutes.** If the user leaves the wallet prompt
  open too long, call `/auth/nonce` again.
- **Tokens do not cache privileges.** `isAdmin` and ban status are re-read from
  the database on every request, so revoking access takes effect immediately
  rather than when the token expires.

Tokens last 7 days by default (`JWT_EXPIRES_IN`).

---

## 2. Conventions: pagination, errors, dates

### Pagination

List endpoints take `?page` (default `1`) and `?limit` (default `24`, **max
100**) and return:

```json
{
  "items": [ ... ],
  "meta": { "page": 1, "limit": 2, "total": 120, "totalPages": 60, "hasMore": true }
}
```

Use `meta.hasMore` for your "LOAD MORE" button and `meta.total` for
"SHOWING 1-24 OF 3,000".

### Errors

Every error has the same shape:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "You need at least 1 ticket(s) to enter" }
```

`message` is a **string** for most errors but an **array of strings** for
validation failures, because a request can fail several rules at once:

```json
{ "message": ["duration must be one of: DAYS_7, DAYS_14, DAYS_30, DAYS_60, DAYS_90"],
  "error": "Bad Request", "statusCode": 400 }
```

Handle both: `Array.isArray(message) ? message.join(', ') : message`.

| Code | Meaning |
| --- | --- |
| `400` | Validation failed, or a rule was broken (not enough tickets, still locked) |
| `401` | Missing, expired or invalid token — send the user back through sign-in |
| `403` | Authenticated but not allowed (not the owner, not a holder, not an admin) |
| `404` | No such tenant, raffle or stake |
| `409` | Conflict. **If `retryable: true` is present, retry once** — it was a transient database collision, not a bad request |
| `429` | Rate limited (60 requests/minute per IP by default) |
| `503` | Could not verify ownership on-chain. Transient — tell the user to try again |

**Unknown fields are rejected.** Posting a field no DTO declares returns `400`,
it is not silently ignored. This stops a client sending `{"isAdmin": true}`.

### Dates

All timestamps are ISO 8601 UTC strings (`2026-09-17T19:18:02.687Z`). Durations
are milliseconds (`timeRemainingMs`). Compute countdowns from `endsAt` /
`closesAt` rather than trusting `timeRemainingMs` after it has sat in state — it
is a snapshot from when the response was built.

---

## 3. Auth

### `GET /auth/nonce` — start sign-in

Public. Returns the nonce **and the message to sign**.

```bash
curl -s "http://localhost:4000/api/auth/nonce?address=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
```

```json
{
  "nonce": "HAwl5QKSsEnb720iJ",
  "message": "localhost:3000 wants you to sign in with your Ethereum account:\n0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n\nSign in to The Loud House.\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: 4663\nNonce: HAwl5QKSsEnb720iJ\nIssued At: 2026-09-17T19:18:02.525Z",
  "expiresAt": "2026-09-17T19:28:02.517Z"
}
```

`400` if `address` is not a valid Ethereum address.

### `POST /auth/verify` — finish sign-in

Public. Exchanges the signed message for a token.

```bash
curl -s -X POST http://localhost:4000/api/auth/verify \
  -H 'content-type: application/json' \
  -d '{"message":"<the message string from /auth/nonce>","signature":"0x<signature from the wallet>"}'
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "cmu5wwnq000007dgbv96m7j4s",
    "walletAddress": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "displayName": null,
    "isAdmin": false
  }
}
```

Note `walletAddress` comes back **lowercased** — always compare addresses
case-insensitively.

| Failure | Code |
| --- | --- |
| Signature does not match, or nonce already used | `401 Signature verification failed` |
| Nonce older than 10 minutes | `401 Nonce expired — request a new one` |
| Wallet is banned | `403` |

### `GET /auth/me` — current session

Requires a token.

```bash
curl -s http://localhost:4000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "cmu5wwnq000007dgbv96m7j4s",
  "walletAddress": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "displayName": null,
  "avatarUrl": null,
  "isAdmin": false,
  "isBanned": false,
  "createdAt": "2026-09-17T19:18:02.520Z"
}
```

Calling any protected route without a token:

```json
{ "message": "Unauthorized", "statusCode": 401 }
```

---

## 4. Collection

All public — the catalogue is browsable before connecting a wallet.

### `GET /collection/nfts` — the catalogue grid

| Param | Default | Notes |
| --- | --- | --- |
| `page` | `1` | |
| `limit` | `24` | max `100` |
| `search` | — | Matches a name or token id. `#0007`, `0007` and `7` all work |
| `background` | — | Exact value, e.g. `Pink` |
| `traitType` + `traitValue` | — | Filter by any trait; **both required together** |
| `sort` | `tokenId:asc` | `tokenId:asc`, `tokenId:desc`, `rarity:asc`, `rarity:desc` |
| `owner` | — | Lowercase wallet address |
| `maxRarityRank` | — | Only tenants ranked at or below this |

```bash
curl -s "http://localhost:4000/api/collection/nfts?page=1&limit=2"
```

```json
{
  "items": [
    {
      "id": "cmu5wwltg00007dfp2s8ykp1q",
      "tokenId": 1,
      "name": "Tenant #0001",
      "editionName": "LOUD HEADS",
      "imageUrl": "https://placehold.co/600x600/png?text=%230001",
      "thumbnailUrl": null,
      "background": "Red",
      "rarityRank": 103,
      "ownerAddress": "0x71af6f0e1b2c3d4e5f60718293a4b5c6d7e8f900"
    }
  ],
  "meta": { "page": 1, "limit": 2, "total": 120, "totalPages": 60, "hasMore": true }
}
```

More examples:

```bash
# Search box: "#0007"
curl -s "http://localhost:4000/api/collection/nfts?search=%230007"

# Background filter + rarity sort  (rarity:asc = rarest first)
curl -s "http://localhost:4000/api/collection/nfts?background=Pink&sort=rarity%3Aasc&limit=2"

# Everything one wallet holds
curl -s "http://localhost:4000/api/collection/nfts?owner=0x71af6f0e1b2c3d4e5f60718293a4b5c6d7e8f900"

# Filter by an arbitrary trait
curl -s "http://localhost:4000/api/collection/nfts?traitType=Headwear&traitValue=Red%20Beret"
```

> `#` must be percent-encoded as `%23` in a URL, and `:` in the sort value as
> `%3A`. `encodeURIComponent` handles both — don't hand-build the query string.

### `GET /collection/nfts/:tokenId` — one tenant

```bash
curl -s http://localhost:4000/api/collection/nfts/7
```

```json
{
  "id": "cmu5wwltv00067dfp099c2dw3",
  "tokenId": 7,
  "name": "Tenant #0007",
  "editionName": "LOUD HEADS",
  "description": null,
  "imageUrl": "https://placehold.co/600x600/png?text=%230007",
  "animationUrl": null,
  "background": "Pink",
  "ownerAddress": null,
  "rarityRank": 1,
  "rarityScore": 28.05882352941176,
  "traits": [
    { "traitType": "Headwear", "value": "VR Headset", "count": 20, "rarity": 0.1666666666666667 },
    { "traitType": "Background", "value": "Pink", "count": 17, "rarity": 0.1416666666666667 }
  ],
  "isStaked": false,
  "stakedUntil": null
}
```

`rarity` is a fraction — multiply by 100 for the "14.2%" label. `rarityRank: 1`
is the rarest tenant.

`404` for a token id that is not in the collection:

```json
{ "message": "Tenant #99999 not found", "error": "Not Found", "statusCode": 404 }
```

### `GET /collection/traits` — filter dropdowns

```bash
curl -s http://localhost:4000/api/collection/traits
```

Returns every trait type with its values and counts, grouped and ready to render
as `<select>` options:

```json
[
  { "traitType": "Background",
    "values": [ { "traitType": "Background", "value": "Pink", "count": 17, "rarity": 0.1416 } ] }
]
```

### `GET /collection/stats` — header numbers

```bash
curl -s http://localhost:4000/api/collection/stats
```

```json
{ "totalSupply": 120, "uniqueHolders": 2, "stakedCount": 0 }
```

---

## 5. Staking

### `GET /staking/tiers` — the five duration cards

Public — renders before a wallet connects.

```bash
curl -s http://localhost:4000/api/staking/tiers
```

```json
[
  { "duration": "DAYS_7",  "days": 7,  "tickets": 1, "label": "7 DAYS",  "rewardLabel": "EARN 1 TICKET" },
  { "duration": "DAYS_14", "days": 14, "tickets": 2, "label": "14 DAYS", "rewardLabel": "EARN 2 TICKETS" },
  { "duration": "DAYS_30", "days": 30, "tickets": 3, "label": "30 DAYS", "rewardLabel": "EARN 3 TICKETS" },
  { "duration": "DAYS_60", "days": 60, "tickets": 4, "label": "60 DAYS", "rewardLabel": "EARN 4 TICKETS" },
  { "duration": "DAYS_90", "days": 90, "tickets": 5, "label": "90 DAYS", "rewardLabel": "EARN 5 TICKETS" }
]
```

`rewardLabel` is pre-pluralised — render it directly rather than reimplementing
"1 TICKET" vs "2 TICKETS".

### `GET /staking/vault` — the whole Stake page in one call

Requires a token. Returns held tenants, which are still available, active locks
and the ticket balance **from a single instant**.

```bash
curl -s http://localhost:4000/api/staking/vault -H "Authorization: Bearer $TOKEN"
```

```json
{
  "ticketBalance": 0,
  "totalHeld": 3,
  "totalEligible": 2,
  "availableTenants": [
    { "id": "cmu5wwlw4001e7dfpl394sool", "tokenId": 51, "name": "Tenant #0051",
      "imageUrl": "...", "thumbnailUrl": null, "background": "Cream" }
  ],
  "activeStakes": [
    {
      "id": "cmu5wwnun00027dgbkohf8udu",
      "tokenId": 50,
      "name": "Tenant #0050",
      "imageUrl": "...",
      "duration": "DAYS_7",
      "durationDays": 7,
      "ticketsEarned": 1,
      "startsAt": "2026-09-17T19:18:02.687Z",
      "endsAt": "2026-09-24T19:18:02.687Z",
      "isLocked": true,
      "timeRemainingMs": 604799998,
      "canUnstake": false
    }
  ],
  "tiers": [ ... ]
}
```

Mapping to your design:

| Design element | Field |
| --- | --- |
| "7 ELIGIBLE / 9 HELD" | `totalEligible` / `totalHeld` |
| AVAILABLE TENANTS grid | `availableTenants` |
| TICKET BALANCE | `ticketBalance` |
| `LOCKED` vs `UNLOCKED` badge | `isLocked` |
| UNSTAKE button enabled | `canUnstake` |
| "TIME REMAINING 17D 23H 59M" | `endsAt` (count down to it) |
| "TICKETS EARNED 3" | `ticketsEarned` — **pending**, credited on unstake |

`ticketsEarned` on a locked stake is what it *will* pay out. It is added to
`ticketBalance` only when you successfully unstake.

`isLocked` and `canUnstake` are computed per request, so a stake flips to
unlocked the moment `endsAt` passes — no polling for a background job needed.

### `POST /staking/stake` — lock a tenant

```bash
curl -s -X POST http://localhost:4000/api/staking/stake \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tokenId":50,"duration":"DAYS_7"}'
```

**`201 Created`**

```json
{
  "id": "cmu5wwnun00027dgbkohf8udu",
  "tokenId": 50,
  "name": "Tenant #0050",
  "imageUrl": "...",
  "duration": "DAYS_7",
  "durationDays": 7,
  "ticketsEarned": 1,
  "startsAt": "2026-09-17T19:18:02.687Z",
  "endsAt": "2026-09-24T19:18:02.687Z",
  "isLocked": true,
  "timeRemainingMs": 604799998,
  "canUnstake": false
}
```

| Failure | Code | Message |
| --- | --- | --- |
| Already staked | `400` | `Tenant #50 is already staked` |
| Bad duration | `400` | `["duration must be one of: DAYS_7, DAYS_14, DAYS_30, DAYS_60, DAYS_90"]` |
| Not in the collection | `404` | `Tenant #9999 is not part of this collection` |
| Not the owner | `403` | `You do not own tenant #50` |
| Chain unreachable | `503` | `Could not verify ownership on-chain` |

### `POST /staking/unstake/:stakeId` — withdraw and collect

```bash
curl -s -X POST http://localhost:4000/api/staking/unstake/cmu5wwnun00027dgbkohf8udu \
  -H "Authorization: Bearer $TOKEN"
```

**`200 OK`** — returns the stake with `isLocked: false`. The tickets are now in
`ticketBalance`; re-fetch `/staking/vault` to refresh the page.

| Failure | Code | Message |
| --- | --- | --- |
| Still locked | `400` | `Still locked — 7 day(s) remaining` |
| Already withdrawn | `400` | `This stake has already been withdrawn` |
| Not your stake | `403` | `This stake does not belong to you` |
| No such stake | `404` | `Stake not found` |

Safe to retry — a replayed unstake returns `400`, it never pays out twice.

> **Sold the tenant mid-lock?** Ownership is re-checked on withdrawal. If the
> wallet no longer holds it, the stake is cancelled and **no tickets are
> credited**. The call still returns `200`, so read `ticketBalance` from
> `/staking/vault` rather than assuming the payout happened.

---

## 6. Raffles

### Eligibility — read this before wiring the enter button

To enter, a wallet needs **both**:

1. **At least one tenant, right now** (`holdersOnly`, on by default)
2. **Enough tickets**, which only come from completed stakes

So the flow is: **hold → stake → wait out the lock → unstake → enter**. Tickets
earned earlier do not survive selling out; holding is re-checked on every entry.

### `GET /raffles` — open raffles

Public.

```bash
curl -s http://localhost:4000/api/raffles
```

```json
[
  {
    "id": "cmu5wwmqf004b7dfps8n9pwss",
    "slug": "tenant-0103-camo-stalk",
    "title": "TENANT #0103 — 1/1 CAMO STALK",
    "subtitle": "THE LOUD HOUSE / GENESIS DOLLS",
    "description": null,
    "status": "OPEN",
    "prize": { "tokenId": 103, "name": "Tenant #0103", "imageUrl": "..." },
    "entryCost": 1,
    "minTicketsToEnter": 1,
    "holdersOnly": true,
    "eligibilityLabel": "HOLDERS WITH 1+ TICKET",
    "maxEntriesPerUser": null,
    "entryCount": 4,
    "opensAt": "2026-09-16T19:18:01.238Z",
    "closesAt": "2026-09-19T19:18:01.238Z",
    "drawnAt": null,
    "timeRemainingMs": 172798481,
    "winner": null,
    "fairness": {
      "serverSeedHash": "a476aa7742da10f8c1e8b344069afa1df0987839524585e127fe06912fb14a42",
      "serverSeed": null,
      "drawHash": null,
      "entropyBlockNumber": null,
      "entropyBlockHash": null
    }
  }
]
```

`eligibilityLabel` is pre-formatted for the card. `entryCount` is the "1,204
ENTRIES" figure. `serverSeed` is `null` until the draw — that is deliberate, see
[the draw](#get-rafflesslugverify---audit-a-finished-draw).

`status` is one of `SCHEDULED`, `OPEN`, `CLOSED`, `DRAWN`, `CANCELLED`.

### `GET /raffles/:slug` — one raffle

```bash
curl -s http://localhost:4000/api/raffles/tenant-0103-camo-stalk
```

Same shape as above. `404` if the slug does not exist.

### `POST /raffles/:slug/enter` — spend tickets

```bash
curl -s -X POST http://localhost:4000/api/raffles/tenant-0103-camo-stalk/enter \
  -H "Authorization: Bearer $TOKEN"
```

**`201 Created`**

```json
{
  "entryNumber": 5,
  "ticketLabel": "TICKET #000005",
  "raffleSlug": "tenant-0103-camo-stalk",
  "ticketBalance": 0
}
```

`ticketBalance` is the balance **after** the entry — use it to update the header
without a second request. `ticketLabel` is the pre-padded stub for the ticket
strip.

| Failure | Code | Message |
| --- | --- | --- |
| Not enough tickets | `400` | `You need at least 1 ticket(s) to enter` |
| Raffle closed / not open | `400` | `This raffle is not open for entries` |
| Holds no tenants | `403` | `You need to hold at least one tenant to enter...` |
| Per-wallet cap reached | `409` | `Entry limit reached (N per wallet)` |
| Transient collision | `409` + `retryable: true` | retry once |
| Chain unreachable | `503` | try again shortly |

Double-clicking the button is safe: concurrent entries are serialised per
wallet, so one ticket can only ever buy one entry. The extras fail with `400`.

### `GET /raffles/:slug/my-entries` — this wallet's entries

```bash
curl -s http://localhost:4000/api/raffles/tenant-0103-camo-stalk/my-entries \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "count": 1, "entries": [ { "entryNumber": 5, "createdAt": "2026-09-17T19:18:02.770Z" } ] }
```

### `GET /raffles/entries/recent` — the TICKET STRIP

Public. The five most recent entries across **all** raffles.

```bash
curl -s http://localhost:4000/api/raffles/entries/recent
```

```json
[
  {
    "entryNumber": 5,
    "ticketLabel": "TICKET #000005",
    "raffle": { "slug": "tenant-0103-camo-stalk", "title": "TENANT #0103 — 1/1 CAMO STALK" },
    "wallet": "0xF39…266",
    "createdAt": "2026-09-17T19:18:02.770Z"
  }
]
```

Addresses are truncated server-side. Full wallet addresses are never returned on
a public endpoint — otherwise anyone could scrape a list of every participant.

### `GET /raffles/history` — past draws

Public, paginated.

```bash
curl -s "http://localhost:4000/api/raffles/history?limit=2"
```

Returns `{ items, meta }` of `DRAWN` raffles, newest first. Each carries a
populated `winner` and a fully revealed `fairness` block:

```json
{ "winner": { "wallet": "0xF39…266", "displayName": null, "entryNumber": 7 } }
```

### `GET /raffles/:slug/verify` — audit a finished draw

**Public on purpose.** Anyone can recompute a result without our cooperation.

```bash
curl -s http://localhost:4000/api/raffles/tenant-0099-doc-demo/verify
```

```json
{
  "valid": true,
  "reasons": [],
  "inputs": {
    "serverSeed": "2b06f158dfd577b6c68aa289bd8fdaad86aabbdb04556876eed396f05be87a45",
    "serverSeedHash": "29150ba5f4f72818550af934951ca6b3330776ccf758131096bbc66e716cf14f",
    "raffleId": "cmu5wwnz1000e7dgbmoum4iic",
    "entryCount": 8,
    "entropyBlockNumber": null,
    "entropyBlockHash": null,
    "drawHash": "e3c00f007a09736034d6c50b8cc69733a0231421bd3754772e78cbbacc2d16a1",
    "winningIndex": 1,
    "winningEntryNumber": 7
  },
  "howToVerify": [
    "sha256(serverSeed) must equal serverSeedHash, which was published when the raffle was created.",
    "drawHash = sha256(`${serverSeed}:${entropyBlockHash}:${raffleId}`).",
    "winningIndex = BigInt(0x + drawHash) % entryCount.",
    "The winner is the entry at that index when entries are sorted by entryNumber ascending."
  ]
}
```

**Why this matters for the UI:** `serverSeedHash` is published when the raffle is
created, before anyone enters. Show it on the raffle card so holders can record
it. After the draw, `serverSeed` is revealed and they can check it hashes to the
value they saw earlier — proving the winner was fixed in advance and not chosen
after seeing the entries. A "verify this draw" link on past raffles is worth
building; the honesty is the feature.

`400` if the raffle has not been drawn yet.

---

## 7. Operator (admin only)

Require a token whose wallet has `isAdmin`. Everyone else gets:

```json
{ "message": "Admin access required", "error": "Forbidden", "statusCode": 403 }
```

### `POST /raffles` — create a raffle

Generates the fairness commitment at creation, before any entries exist.

```bash
curl -s -X POST http://localhost:4000/api/raffles \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "slug": "tenant-0099-doc-demo",
    "title": "TENANT #0099 — DOC DEMO",
    "subtitle": "THE LOUD HOUSE / GENESIS DOLLS",
    "prizeTokenId": 99,
    "entryCost": 1,
    "minTicketsToEnter": 1,
    "holdersOnly": true,
    "maxEntriesPerUser": null,
    "opensAt": "2026-09-17T19:00:00.000Z",
    "closesAt": "2026-09-19T19:00:00.000Z"
  }'
```

**`201 Created`.** `slug`, `title`, `opensAt` and `closesAt` are required; the
rest have defaults (`entryCost: 1`, `minTicketsToEnter: 1`, `holdersOnly: true`,
`maxEntriesPerUser: null` = unlimited).

`400` if `closesAt` is not after `opensAt`. `404` if `prizeTokenId` is not in the
collection.

### `POST /raffles/:id/draw` — run the draw

Takes the raffle **id**, not the slug.

```bash
curl -s -X POST http://localhost:4000/api/raffles/cmu5wwnz1000e7dgbmoum4iic/draw \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**`200 OK`** — returns the raffle with `status: "DRAWN"`, a populated `winner`,
and `fairness.serverSeed` now revealed.

| Failure | Code | Message |
| --- | --- | --- |
| Entries still open | `400` | `Cannot draw before entries close` |
| No entries | `400` | `No entries to draw from` |
| Already drawn | `409` | `This raffle has already been drawn` |

---

## 8. End-to-end script

Paste this into a terminal with the server running and the database seeded. It
walks the whole flow and prints each response. Requires `node` and `jq`.

```bash
#!/usr/bin/env bash
set -e
B=http://localhost:4000/api
ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# 1. Get the nonce and the message to sign
NONCE_JSON=$(curl -s "$B/auth/nonce?address=$ADDR")
MESSAGE=$(echo "$NONCE_JSON" | jq -r .message)

# 2. Sign it. In the browser this is wagmi's signMessageAsync; here we use viem.
SIG=$(node -e "
const { privateKeyToAccount } = require('viem/accounts');
const a = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
a.signMessage({ message: process.argv[1] }).then(s => console.log(s));
" "$MESSAGE")

# 3. Exchange it for a token
PAYLOAD=$(jq -n --arg m "$MESSAGE" --arg s "$SIG" '{message:$m,signature:$s}')
TOKEN=$(curl -s -X POST "$B/auth/verify" -H 'content-type: application/json' \
  -d "$PAYLOAD" | jq -r .accessToken)
echo "token acquired"

AUTH="Authorization: Bearer $TOKEN"

# 4. Look at the vault
curl -s "$B/staking/vault" -H "$AUTH" | jq '{ticketBalance, totalHeld, totalEligible}'

# 5. Stake a tenant you hold
STAKE_ID=$(curl -s -X POST "$B/staking/stake" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"tokenId":50,"duration":"DAYS_7"}' | jq -r .id)
echo "staked: $STAKE_ID"

# 6. Unstaking now fails — it is still locked
echo "unstake while locked: $(curl -s -X POST "$B/staking/unstake/$STAKE_ID" -H "$AUTH" | jq -r .message)"

# 7. DEV ONLY: fast-forward the lock so we can see the whole loop without
#    waiting seven days. Never do this against a real database.
psql "postgresql://loudhouse:loudhouse@localhost:5432/loudhouse" -q \
  -c "UPDATE stakes SET \"endsAt\" = NOW() - INTERVAL '1 hour' WHERE id='$STAKE_ID'"

# 8. Now it is unlocked — withdrawing credits the tickets
curl -s -X POST "$B/staking/unstake/$STAKE_ID" -H "$AUTH" | jq '{isLocked, canUnstake, ticketsEarned}'
curl -s "$B/staking/vault" -H "$AUTH" | jq '{ticketBalance}'

# 9. Enter a raffle with the ticket we just earned
SLUG=$(curl -s "$B/raffles" | jq -r '.[0].slug')
curl -s -X POST "$B/raffles/$SLUG/enter" -H "$AUTH" | jq

# 10. Spending the same ticket twice is refused
echo "second entry: $(curl -s -X POST "$B/raffles/$SLUG/enter" -H "$AUTH" | jq -r .message)"
```

Expected output:

```
token acquired
{ "ticketBalance": 0, "totalHeld": 3, "totalEligible": 3 }
staked: cmu5x1kgk00037dqdwufye3bv
unstake while locked: Still locked — 7 day(s) remaining
{ "isLocked": false, "canUnstake": false, "ticketsEarned": 1 }
{ "ticketBalance": 1 }
{ "entryNumber": 5, "ticketLabel": "TICKET #000005",
  "raffleSlug": "tenant-0103-camo-stalk", "ticketBalance": 0 }
second entry: You need at least 1 ticket(s) to enter
```

That last line is the ledger doing its job: one stake earned one ticket, one
ticket bought one entry, and the balance is now zero.

---

## 9. Frontend integration notes

### CORS

The API only accepts the origins in `CORS_ORIGINS` (default
`http://localhost:3000`). Add your deployed frontend origin there or every
request fails at the browser before reaching a handler.

### A minimal typed client

```ts
// lib/api.ts
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryable = false) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // `message` is a string for most errors, an array for validation failures.
    const raw = (body as { message?: string | string[] }).message;
    const message = Array.isArray(raw) ? raw.join(', ') : (raw ?? res.statusText);
    throw new ApiError(res.status, message, Boolean((body as { retryable?: boolean }).retryable));
  }

  return body as T;
}
```

### Signing in with wagmi

```ts
import { useAccount, useSignMessageAsync } from 'wagmi';

async function signIn(address: `0x${string}`, signMessageAsync: ReturnType<typeof useSignMessageAsync>) {
  // Ask the server for the message — never build the EIP-4361 string yourself.
  const { message } = await api<{ nonce: string; message: string; expiresAt: string }>(
    `/auth/nonce?address=${address}`,
  );

  const signature = await signMessageAsync({ message });

  const session = await api<{ accessToken: string; user: { walletAddress: string; isAdmin: boolean } }>(
    '/auth/verify',
    { method: 'POST', body: JSON.stringify({ message, signature }) },
  );

  return session;
}
```

Store `accessToken` wherever you keep session state. On any `401`, clear it and
send the user back through sign-in — the token has expired or the nonce was
already consumed.

### Which calls each page needs

| Page | Calls |
| --- | --- |
| Collection | `GET /collection/nfts` (paged), `GET /collection/traits` for the dropdowns, `GET /collection/stats` for the header |
| Tenant detail | `GET /collection/nfts/:tokenId` |
| Stake | `GET /staking/vault` — everything in one call. Then `POST /staking/stake` and `POST /staking/unstake/:id`, re-fetching the vault after each |
| Raffle House | `GET /raffles`, `GET /raffles/entries/recent`, `GET /raffles/history`, `GET /staking/vault` for the balance. Then `POST /raffles/:slug/enter` |

### Countdown timers

Compute from `endsAt` / `closesAt` with a local `setInterval`. Do not poll the
API every second — `isLocked` and `canUnstake` are derived from the clock, so a
single fetch plus a local timer stays correct. Re-fetch when a countdown reaches
zero to pick up the state change.

### Demo mode

While `DEMO_MODE=true`, on-chain ownership checks are bypassed: any wallet can
stake any tenant and the holder requirement is skipped. That is intended for
frontend development. When it is turned off, expect new `403` and `503` paths —
make sure your error handling surfaces `message` to the user rather than a
generic "something went wrong".
