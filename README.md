# The Loud House — Backend

NestJS + Prisma API for the collection catalogue, the staking vault and the Raffle House.

---

## The one thing to understand first

The designs say two things that decide the entire architecture:

> **"OFF-CHAIN ENTRY — NO WALLET SIGNATURE OR CONTRACT TRANSACTION"** (Raffle House)
> **"Demo only — no wallet or contract is connected yet."** (Stake page)

Staking and raffles do **not** run on a smart contract. This database is the
source of truth. Nobody can check our work against the chain, and there is no
contract refusing an invalid state on our behalf.

Three consequences run through the whole codebase:

1. **Ownership must be verified by us.** Nothing else stops a wallet farming
   tickets on a tenant it does not hold. Checked on the way in *and* on the way
   out — see `StakingService.unstake`.
2. **Tickets live in an append-only ledger**, never a mutable `balance` column.
   `TicketsService` explains the double-spend that a plain integer allows.
3. **Draws are provably fair** by commit-reveal, so holders can audit a result
   instead of trusting us. See `DrawService` — it is the most commented file
   here and worth reading first.

---

## Running it

```bash
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
npm install
npx prisma migrate dev        # create the schema
npm run db:seed               # tenants, a demo holder, an open raffle
npm run start:dev
```

- API: `http://localhost:4000/api`
- Swagger: `http://localhost:4000/api/docs`

Need a Postgres quickly:

```bash
docker run --name loudhouse-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=loudhouse -p 5432:5432 -d postgres:16
```

Generate a real `JWT_SECRET` with `openssl rand -base64 48`. The app refuses to
boot with a short one — see `src/config/env.validation.ts`.

---

## Layout

```
src/
  config/            environment parsing, validation, staking tiers
  common/
    prisma/          the database client, exported globally
    decorators/      @Public(), @CurrentUser()
    dto/             shared pagination
  modules/
    auth/            Sign-In-With-Ethereum, JWT, guards
    chain/           ownership checks via viem
    collection/      the catalogue: search, filters, sorting, rarity
    tickets/         the ticket ledger
    staking/         the vault
    raffles/         the Raffle House and the draw
```

Every route requires a JWT **by default** — the guard is global and you opt out
with `@Public()`. That direction is deliberate: forgetting the decorator gives
you a 401 you notice immediately, rather than an endpoint quietly open to the
world.

---

## Endpoints

### Auth — wallet sign-in

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/auth/nonce?address=0x…` | Returns the nonce **and the exact message to sign** |
| `POST` | `/api/auth/verify` | `{ message, signature }` → JWT |
| `GET` | `/api/auth/me` | Current session |

The frontend never assembles the EIP-4361 string itself; it signs what
`/auth/nonce` hands back. Frontends building that string by hand is the usual
cause of "signature verification failed".

### Collection — the catalogue page

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/collection/nfts` | `?page&limit&search&background&sort&owner` |
| `GET` | `/api/collection/nfts/:tokenId` | One tenant, full traits |
| `GET` | `/api/collection/traits` | Values + counts for the filter dropdowns |
| `GET` | `/api/collection/stats` | Supply, holders, staked count |

`search` accepts `#0001`, `0001`, `1` or a name.

### Staking — the vault

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/staking/tiers` | The five duration cards (public) |
| `GET` | `/api/staking/vault` | Held, eligible, active locks, balance — one call |
| `POST` | `/api/staking/stake` | `{ tokenId, duration }` |
| `POST` | `/api/staking/unstake/:stakeId` | Matured locks only; credits tickets |

`GET /staking/vault` returns everything the page needs in one response, because
"3 ELIGIBLE / 9 HELD" only makes sense if both numbers come from the same
instant.

### Raffles — the Raffle House

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/raffles` | Open raffles |
| `GET` | `/api/raffles/:slug` | One raffle |
| `GET` | `/api/raffles/history` | Past draws |
| `GET` | `/api/raffles/entries/recent` | The TICKET STRIP |
| `GET` | `/api/raffles/:slug/verify` | **Recompute a finished draw yourself** |
| `POST` | `/api/raffles/:slug/enter` | Spends tickets |
| `POST` | `/api/raffles` | Operator: create (commits the seed) |
| `POST` | `/api/raffles/:id/draw` | Operator: draw and reveal |

---

## How the three tricky parts work

### 1. Tickets are a ledger, not a number

A `ticketBalance` column looks obvious and is wrong. Two concurrent entries
both read `1`, both pass the check, both write `0` — one ticket, two entries.

So: `TicketLedger` rows are append-only and the balance is `SUM(delta)`. To
reverse something you write an opposing row; you never edit history.

That alone is not enough, because two transactions can still both read the sum
before either writes. `TicketsService.debit` takes a `SELECT … FOR UPDATE` row
lock on the user first, which serialises spending per wallet. Plus:
`TicketLedger.stakeId` and `raffleEntryId` are **unique**, so a replayed
unstake cannot mint a second reward — idempotency you cannot forget to code.

**A deadlock this actually hit.** Entering a raffle originally inserted the
entry, then ran `UPDATE raffles SET entryCount`. Inserting a child row takes a
`FOR KEY SHARE` lock on the parent `raffles` row (the foreign key); the update
then wants `FOR UPDATE` on that same row. Two simultaneous entries each held the
share lock and each waited for the other — Postgres `40P01`, surfaced to users
as a 500.

The fix is the general rule for deadlocks: **transactions touching the same rows
must take locks in the same order, strongest first.** `RafflesService.enter` now
opens with `SELECT … FROM raffles WHERE id = … FOR UPDATE`, so the second
request waits instead of deadlocking. Entries to one raffle are serialised,
which is cheap and is what we want anyway — `entryNumber` order decides the draw.

`PrismaExceptionFilter` also maps deadlocks to a retryable **409** rather than a
500, because they are transient and a client can sensibly retry them.

### 2. Double-staking is blocked by the database

`Stake.activeNftId` mirrors `nftId` while the lock is active and is set to
`NULL` on withdrawal, with a unique index on it. Postgres treats every `NULL`
in a unique index as distinct, so any number of finished stakes coexist, but
only one live lock per tenant is possible.

`StakingService.stake` therefore does not pre-check with a `SELECT`. It
attempts the insert and catches Prisma's `P2002`. A pre-check loses the race;
the constraint cannot.

### 3. Draws are provably fair

Real 1/1 prizes decided by a server we control. "Trust us" is not good enough,
and it is not necessary:

1. **At creation**, generate `serverSeed`, publish only `sha256(serverSeed)`.
   Holders can screenshot it before entries open.
2. **Entries come in.** The seed cannot change — the hash is already public.
3. **After close**, mix in the hash of a block mined *after* entries closed, so
   we could not have ground through seeds looking for a favourable result.
4. **Reveal the seed.** Anyone recomputes the winner and checks the hash
   matches step 1.

`GET /api/raffles/:slug/verify` does this and returns every input, so a holder
can redo it by hand. It is public on purpose — auditability that requires our
cooperation is not auditability.

`serverSeed` is withheld from every response until `drawnAt` is set. This is
why `RafflesService.toPublicDto` maps fields by hand instead of returning the
Prisma object: a `select` you forget to narrow ships the secret.

---

## `DEMO_MODE`

With `DEMO_MODE=true`, `OwnershipService` **skips on-chain ownership checks** —
matching "no wallet or contract is connected yet" in the designs, so you can
build the frontend before the contract is wired up.

**It must be `false` in production.** With it on, any wallet can stake any
tenant. The app logs a warning on every boot while it is enabled.

Note that when demo mode is off and the RPC is unreachable, ownership checks
**throw** rather than pass. Failing closed is deliberate: better to reject a
legitimate stake than to mint tickets that get spent on a 1/1 you cannot claw
back.

---

## Still to build

- [ ] **Indexer** — sync `ownerAddress` from Transfer events; the catalogue and
      vault both read it, and right now only the seed populates it.
- [ ] **OpenSea integration** — floor price and listings, server-side so the API
      key never reaches the browser.
- [ ] **Snapshot module** — the `SNAPSHOT` nav item; models exist, no service yet.
- [ ] **Content endpoints** — artists and team for the landing page; the
      `Person` model is seeded but has no controller.
- [ ] **Tests** — `DrawService` has 12 unit tests. Still wanted: an automated
      concurrency test for the ledger (currently verified by hand, see below)
      and controller-level e2e tests.

---

## What has been verified end to end

Run against a real Postgres, not mocks:

| Check | Result |
| --- | --- |
| SIWE sign-in with a real secp256k1 signature | JWT issued |
| Replaying that same signature | 401 — nonce was rotated |
| Protected route with no token | 401 |
| Staking a tenant, then staking it again | 400 "already staked" |
| **5 simultaneous stakes on one tenant** | **exactly 1 succeeded** |
| Unstaking before maturity | 400 with days remaining |
| Unstaking after maturity | tickets credited |
| Replaying the unstake | 400, balance unchanged (not double-credited) |
| **5 simultaneous raffle entries on a 1-ticket balance** | **1 accepted, 4 rejected, balance 0 — never negative** |
| `serverSeed` before the draw | `null` in every response |
| Drawing before entries close | 400 |
| Recomputing the draw independently of the server | matches |
