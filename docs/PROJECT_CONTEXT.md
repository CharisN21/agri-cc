# Project context

For whoever picks this up next — human or agent. Read this before your first
edit. Read the files the task names; don't read the whole repo.

---

## What the business actually does

A company contracts smallholder farmers in Nakuru county to grow sunflower for
oilseed. The cycle, and every screen in the app, follows it in order:

1. **Register** a farmer and their parcel. Acreage drives everything downstream.
2. **Offer** a contract for the season, then **sign** it. Offering is not signing.
3. **Issue** certified seed on credit against the signed contract. This is a debt.
4. **Weigh in** the grain at harvest: gross on the weighbridge, tare for bags and
   vehicle.
5. **Grade** it from four laboratory readings. The grade is derived, never chosen.
6. **Settle**: price the load, deduct county cess, recover part of the seed debt,
   pay the balance.
7. **Pay** by mobile money, through an outbox so a provider outage cannot lose an
   approval.

The owner watches four things, which is exactly what the dashboard shows:
tonnage, margin, credit recovery, and what is about to break.

### Vocabulary you will meet

- **Outgrower** — a contracted smallholder. The company does not farm.
- **KEPHIS** — Kenya Plant Health Inspectorate Service. Certified seed carries a
  tag number, a germination rate, and a retest due date. Seed past its retest
  date must not be planted, so the app refuses to issue it.
- **Cess** — a county government levy on agricultural produce, 0.5% here.
- **Side-selling** — a farmer takes seed on credit from us and sells the harvest
  to someone else. It is the single biggest commercial risk in outgrower
  schemes, which is why the dashboard ranks farmers by delivered ÷ contracted.
- **M-Pesa** — the mobile money network. Payouts go to a phone number, and the
  name registered there does not always match the national ID name.

---

## Units — the one thing you must not get wrong

| Quantity | Stored as | Suffix | Example |
|---|---|---|---|
| Money | integer cents | `_cents` | KES 58.40 → `5840` |
| Weight | integer grams | `_g` | 620.5 kg → `620500` |
| Percentage | integer basis points | `_bp` | 41.20% → `4120` |

**No floating-point number may appear in any money or weight calculation.**

Conversion happens in exactly one place: `src/domain/units.js`. Call `toCents`,
`toGrams`, `toBp` when parsing an HTTP form; call `money`, `kg`, `pct` when
rendering a template. Never in between.

If you find yourself writing `parseFloat` on a price, or `* 1.05` on a weight,
stop — you are about to introduce a rounding error that will show up months later
as a farmer's balance that does not tie out.

Rounding is one rule, `divRound`: half away from zero. It refuses non-integer
input rather than quietly producing a float, and never returns `-0`.

---

## Architecture, and why

```
migrations/*.sql   the rulebook. Constraints and triggers ARE the invariants.
src/domain/*       pure functions. No db, no clock, no randomness.
src/repo.js        the only file that writes. Everything money-touching in tx().
src/routes/*       HTTP. Converts units in and out. Checks permissions.
src/views/*        EJS. Formats, decides nothing.
src/dashboard.js   read-only aggregation. Every number computed from rows.
```

The shape is deliberate: **the rules live in the database, the arithmetic lives
in pure functions, and everything else is plumbing.** That means you can verify
the two things that matter — that bad writes are refused, and that money is
computed correctly — without running the web server at all.

### Non-negotiable invariants

Never break these. If a task seems to require it, stop and say so.

1. **`stock_movement` and `ledger_entry` are append-only.** Stock on hand and
   farmer balances are `SUM(...)` over them. Never add a cached balance column —
   a test asserts that none exists.
2. **No input issue against an unsigned contract. No settlement without a
   quality test.** Enforced in `repo.js` AND by triggers. Keep both.
3. **Every settlement stores `price_schedule_id`.** Price schedules are
   immutable; changing a price inserts a new version. A settlement must read the
   same in two years as it does today.
4. **Every payment has a unique `idempotency_key`.** Retries must never create a
   second payout.
5. **Anything touching money or stock runs inside `tx()`.**
6. **`net_g` is a generated column.** Never write to it.
7. **Pure domain functions stay pure.** They are the only code that turns a
   physical fact into money and must stay reproducible.
8. **The grader must not approve their own settlement.** Role check in
   `auth.js`, individual check in `repo.js`, trigger in the schema.

---

## Two judgement calls worth knowing about

**"Margin" on the dashboard is a buying margin, not a gross profit.** We record
buying grain; we do not record selling it. A gross-profit column here would be
the purchase value wearing a different hat — which is precisely the failure mode
seen in the sibling app's export, where cost was zero and so "gross profit"
equalled revenue. What the owner can actually act on is whether we bought below
the season's base price, so that is what the pane reports and how it is labelled.
If sales are ever recorded, revisit `moneyPane` in `src/dashboard.js`.

**Debt recovery is written at approval, not at computation.** A settlement can
be computed and then rejected; the farmer's debt should not move until someone
with authority releases the money. The consequence is that computing two
settlements for one farmer before approving either will size both against the
same opening balance. With one settlement per delivery and same-day approval
this has not bitten, but it is the sharpest edge in the model.

---

## Working style

- Plan before touching more than two files. Small diffs. Do not refactor code
  the task did not name.
- Adding a table or column is a **new** file in `migrations/` (`002_x.sql`).
  Never edit an applied migration. Only `NNN_*.sql` is applied locally —
  `supabase.sql` is Postgres and is skipped on purpose.
- Add a test in `test/` for every new rule in `src/domain/`. Run `npm test`
  before calling anything done.
- Reuse the classes in `public/app.css`. No frontend framework, no CSS
  framework, no build step, no new dependency without asking.
- Do not write to `data/` or commit it.

**Definition of done:** `npm test` passes, `npm run prove:append-only` and
`npm run prove:rules` both exit zero, `npm run reset && npm run setup &&
npm start` works from clean, and you could describe the change in one sentence
to the owner.
