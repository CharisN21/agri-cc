# Sunflower outgrower management

A contract-farming system for a sunflower oilseed business in Kenya. The company
issues certified seed to smallholder farmers **on credit**, buys the grain back
at harvest **graded by quality**, recovers the input debt out of the payment, and
pays the balance by mobile money.

Node 20+, Express, SQLite via better-sqlite3, server-rendered EJS, one plain CSS
file. No frontend framework, no build step, no ORM, no CSS framework, no auth
library. Three runtime dependencies.

---

## Run it

```bash
npm install && npm run setup && npm start
```

Then open <http://localhost:3000>.

Seeded accounts — the password is the username followed by `123`:

| Username | Role | What they can do |
|---|---|---|
| `owner` | owner | Everything, including the dashboard |
| `ops` | ops_manager | Contracts, issues, approvals |
| `field1`, `field2` | field_officer | Register farmers, issue seed, grade loads |
| `clerk` | clerk | Weigh in, grade, compute settlements — **cannot approve** |
| `finance` | finance | Approve settlements and run payouts |

Sign in as `clerk` and try to approve a settlement to see the separation enforced.

Other commands:

```bash
npm test          # the full suite, node --test, no framework
npm run reset     # delete the local database
npm run worker    # drain the payment outbox once (--loop to keep going)
```

---

## Prove the invariants reject bad writes

Two commands. Neither imports the application — both open the database file
directly with a raw SQLite driver and issue exactly the writes a careless
script, a bad migration, or a person with a SQL client would issue. If these
rules lived only in route handlers, every line below would succeed.

```bash
npm run prove:append-only
```

```bash
npm run prove:rules
```

Expected output — every attempt refused, and `prove:rules` leaves nothing behind
(its one destructive case runs inside a savepoint that is always rolled back):

```
  refused   UPDATE a stock movement
            stock_movement is append-only: UPDATE rejected
  refused   Overdraw seed stock
            stock would go negative: movement rejected
  refused   Issue seed against unsigned contract CTR-0012
            cannot issue inputs against an unsigned contract
  refused   Settle a delivery that has no quality test
            cannot settle a delivery with no quality test
  refused   Pay PMT-00001 a second time with the same idempotency key
            UNIQUE constraint failed: payment.idempotency_key
```

Both scripts exit non-zero if anything is wrongly accepted, so they work in CI.

---

## The rules, and where they are enforced

Every rule below is a database trigger or constraint, not only application code.

| Rule | Enforced by |
|---|---|
| `stock_movement` and `ledger_entry` are append-only | `*_no_update` / `*_no_delete` triggers |
| Stock can never go negative | `stock_movement_no_negative` trigger |
| Seed cannot be issued against an unsigned contract | `input_issue_needs_signed_contract` |
| Seed cannot leave a lot overdue for germination retest | `input_issue_blocks_overdue_lot` |
| A settlement needs a quality test | `settlement_needs_quality_test` |
| Net weight is derived, never typed | `net_g` GENERATED column |
| Price schedules are immutable and versioned | `price_schedule_no_update` / `_no_delete` |
| One payout per settlement, ever | `payment.idempotency_key` UNIQUE |
| The grader may not approve their own settlement | `settlement_grader_cannot_approve` |
| A clerk may not approve at all | `PERMISSIONS` in `src/auth.js`, checked per route |

Stock on hand and farmer balances are **always** `SUM(...)` over the append-only
tables. There is no cached balance column anywhere, and a test asserts that none
has been added.

---

## Units

Money is integer **cents**, weight is integer **grams**, percentages are integer
**basis points**. No float appears in any money or weight path. Conversion to and
from human decimals happens only in `src/domain/units.js`, called at the HTTP and
template boundaries.

```
KES 58.40  -> 5840
620.5 kg   -> 620500
41.20%     -> 4120
```

Rounding is one rule everywhere: half away from zero, in `divRound`.

---

## Grading and pricing

```
grade = REJECT  if moisture > 14.00% or foreign matter > 10.00%
        A       if oil >= 41.00% and moisture <= 10.00%
        B       if oil >= 38.00%
        C       otherwise

payable_kg  = net_kg x (1 - max(0, FM% - 2.00%))
unit_price  = base_price
            + (oil% - 40.00%)             x oil premium per point
            - max(0, moisture% - 9.00%)   x moisture discount per point
            - max(0, damage%   - 5.00%)   x damage discount per point
            (floored at zero)
gross_value = payable_kg x unit_price
net_payable = gross_value - county cess - debt recovery
```

Recovery is capped three ways and the binding cap is stored on the settlement
and shown on screen: the contractual share of one delivery, what is actually
owed, and a cash floor below which the farmer must not fall. A load too small to
clear the floor recovers nothing and the farmer is still paid.

Every delivery screen renders the **full working** — each adjustment line in
order — so a farmer with a calculator can reproduce the figure.

---

## Layout

```
migrations/001_init.sql     schema, constraints, triggers — the real rulebook
migrations/supabase.sql     optional Postgres mirror schema (not run locally)
src/domain/                 pure functions: units, grading, pricing, settlement
src/db.js                   handle, migration runner, tx()
src/repo.js                 the only file that writes to the database
src/routes/                 HTTP, and the unit boundary
src/views/                  EJS
src/payments/               provider interface + outbox worker
src/cloud/                  optional Supabase push
src/dashboard.js            the four panes, computed from rows
public/app.css              the whole design system
scripts/                    the two invariant proofs
test/                       node --test
```

`src/domain/*` must not import the database, read the clock, or use
`Math.random()`. They turn a physical fact into money and must stay reproducible.

---

## Payments

Approving a settlement writes three things in **one transaction**: the status
change, the debt recovery ledger entry, and the payment instruction in `outbox`.
A separate worker drains the outbox. The provider is behind an interface
(`src/payments/provider.js`); a real M-Pesa Daraja B2C client drops in without
touching business logic.

Draining the outbox twice produces exactly one payment — the payment insert is
`ON CONFLICT(idempotency_key) DO NOTHING`, and a test asserts it.

---

## Host-app integration

`GET /api/widget` returns a compact JSON tile for embedding in a host dashboard:
headline metric, target, status, three secondary figures, a drill URL, the
permission a viewer needs, and a `generated_at` stamp. Five indexed queries, no
joins over the whole season, and a 30-second cache header — it cannot be the
reason a host dashboard hangs.

---

## Optional: Supabase cloud mirror

Local SQLite stays the system of record. The mirror is a one-way push so head
office can read the season without reaching into the store's laptop. The app runs
completely without it.

1. Create a project at supabase.com.
2. Run `migrations/supabase.sql` in the Supabase SQL editor. It recreates the
   same tables **and the same append-only triggers**, and enables row level
   security on every table.
3. `cp .env.example .env` and fill in `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` from Project Settings → API.
4. `npm run cloud:push`, or press Push on the Cloud screen.

The push is watermark-based over append-only tables, so it resumes after an
interruption without duplicating anything. Passwords are never mirrored. The
service role key bypasses RLS and must never reach a browser — it is read from
`.env`, which is gitignored.

---

## Deploying to Render (free tier, demo only)

`render.yaml` is a Blueprint. Push this repo to GitHub, then in Render choose
**New → Blueprint** and point it at the repo. It builds with `npm ci` and starts
with `npm run setup && npm start`.

**Understand the tradeoff before you show anyone.** Render's free tier has no
persistent disk, so the SQLite file is wiped on every deploy and every restart —
including the restart after the 15-minute idle spin-down. The app **reseeds
itself from scratch** each time it wakes. Anything typed into the deployed
demo disappears. That is the deliberate cost of a free deployment; it is a
showcase, not a system of record.

Two other free-tier adaptations, both in `render.yaml`:

- **No background workers**, so `WORKER_IN_PROCESS=true` drains the payment
  outbox on a 15-second timer inside the web process. Same `drainOutbox()`, same
  idempotency guarantee. On a paid plan, drop that variable and run
  `npm run worker` as its own service.
- **Cold starts take about a minute.** The health check hits `/api/widget`,
  which is the cheapest route in the app.

### Before you make it public

The seeded passwords are printed in this README. Set **`SEED_PASSWORD`** in the
Render dashboard to something else — the login page then stops advertising the
defaults and simply says to ask whoever deployed it. `SESSION_SECRET` is
generated by Render automatically; never commit one.

### When you outgrow the demo

Two ways to get real persistence:

1. Attach a Render **persistent disk** mounted at `./data` (needs a paid instance).
2. Make **Supabase Postgres the primary** database instead of a mirror. The
   schema and the same triggers are already in `migrations/supabase.sql`; the
   work is swapping the driver and the queries in `src/repo.js`. The app then
   becomes stateless and any free host will do.

---

# v2 — outsourcing, targets, referrals

The second build adds the things the client asked for after seeing v1.

## Supply runs (outsourcing)

Buying from farmers we never contracted. The unit of work is the **trip**, not
the load, because one lorry hire covers everything on board — and landed cost
per tonne only means something once the trip's costs are spread across what it
brought back.

- Open a run, buy loads onto it, record what the trip cost (transport, fuel,
  labour, loading, field officer food, housing allowance, levies), then close it.
- Grading uses **exactly** the same rules as contracted grain — one
  `quality_test` table serves both, so the criteria cannot drift apart.
- Each run reports grain cost per tonne, trip cost per tonne, and the true
  landed cost — then compares it against what contracted grain **actually** cost
  this season (not the headline base price, which would flatter it).
- Trip costs are allocated across loads by weight using largest-remainder, so
  the shares always add back to exactly the total. No cent is lost or invented.

### Negotiated prices stay auditable

Spot loads have their own immutable, versioned price schedule. Every purchase
stores **two** prices: what the grade said it was worth, and what the officer
actually agreed. A negotiated price is allowed — but a database trigger refuses
one that gives no reason. Six months later you can still see which deals were
struck above the grade, by how much, and why.

## Targets

The owner sets a company tonnage target and a target per ward. A field officer
sees **their own ward's** number on a strip at the top of every screen; everyone
else sees the company total. Nobody has to open a dashboard they may not have
access to in order to know whether the season is on track.

## Referrals

A working list of contractors to call. Deliberately mutable — a lead is a note,
not a financial record — but every logged call **appends** a dated line rather
than overwriting, so nothing said on the phone is lost. A lead converts to a
supplier in one click.

## Seed cost calculator

Acreage × seeding rate × lot cost, for the owner planning a season and the field
officer standing in front of a farmer. Seeding rates live in the `seeding_rate`
table, so the agronomic assumption is data the owner can change. It also shows
how much grain the farmer must deliver just to clear the seed debt.

## Season selector and units

Every screen is scoped to a season, chosen from the top bar and remembered in a
cookie. Weights read in kilograms or tonnes on a toggle; storage is always grams.

## New roles rules

The v1 principle — the person who decides the grade never releases the money —
extends to outsourcing: a field officer can **buy** a spot load but cannot
**pay** for one. Only the owner can change a target or a spot price.
