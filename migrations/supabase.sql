-- Supabase (Postgres) mirror schema.
--
-- Paste this into the Supabase SQL editor once, then set SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY in .env and run `npm run cloud:push`.
--
-- This is a MIRROR, not the system of record. Local SQLite is authoritative.
-- The append-only and immutability rules are repeated here anyway, so that a
-- mistake made through the Supabase dashboard is refused exactly as it would be
-- refused locally. Money is bigint cents, weight bigint grams, percentages int
-- basis points — identical to the local schema.

create table if not exists app_user (
  id bigint primary key, username text not null unique, full_name text not null,
  role text not null, active int not null default 1, created_at text
);
create table if not exists location (
  id bigint primary key, code text not null unique, name text not null,
  kind text not null, parent_id bigint references location(id)
);
create table if not exists season (
  id bigint primary key, code text not null unique, name text not null,
  starts_on text not null, ends_on text not null, target_g bigint not null,
  status text not null default 'open'
);
create table if not exists price_schedule (
  id bigint primary key, season_id bigint not null references season(id),
  version int not null, effective_from text not null,
  base_price_cents bigint not null, oil_premium_cents bigint not null,
  moisture_discount_cents bigint not null, damage_discount_cents bigint not null,
  cess_bp int not null default 50, recovery_share_bp int not null default 5000,
  cash_floor_cents bigint not null default 200000, created_at text,
  unique (season_id, version)
);
create table if not exists farmer (
  id bigint primary key, code text not null unique, full_name text not null,
  national_id text not null unique, phone text not null, mm_name text not null,
  ward_id bigint not null references location(id), status text not null default 'Active',
  notes text not null default '', registered_on text not null,
  registered_at text not null, created_at text
);
create table if not exists parcel (
  id bigint primary key, farmer_id bigint not null references farmer(id),
  code text not null unique, acreage_bp int not null,
  gps_lat text, gps_lng text, notes text not null default ''
);
create table if not exists contract (
  id bigint primary key, code text not null unique,
  farmer_id bigint not null references farmer(id),
  parcel_id bigint not null references parcel(id),
  season_id bigint not null references season(id),
  expected_g bigint not null, seed_entitlement_g bigint not null,
  recovery_share_bp int not null default 5000, status text not null default 'Offered',
  offered_on text not null, signed_on text, signed_at text,
  notes text not null default '', created_at text
);
create table if not exists item (
  id bigint primary key, code text not null unique, name text not null,
  kind text not null, unit text not null default 'g'
);
create table if not exists lot (
  id bigint primary key, code text not null unique,
  item_id bigint not null references item(id), kephis_tag text not null unique,
  germination_bp int not null, retest_due_on text not null,
  unit_cost_cents bigint not null, received_on text not null,
  notes text not null default ''
);
create table if not exists stock_movement (
  id bigint primary key, item_id bigint not null references item(id),
  lot_id bigint references lot(id), location_id bigint not null references location(id),
  qty_g bigint not null, reason text not null, ref_table text, ref_id bigint,
  notes text not null default '', created_by bigint, created_at text
);
create table if not exists input_issue (
  id bigint primary key, code text not null unique,
  contract_id bigint not null references contract(id),
  farmer_id bigint not null references farmer(id),
  lot_id bigint not null references lot(id), qty_g bigint not null,
  unit_cost_cents bigint not null, value_cents bigint not null,
  issued_on text not null, issued_at text not null,
  notes text not null default '', created_by bigint, created_at text
);
create table if not exists ledger_entry (
  id bigint primary key, farmer_id bigint not null references farmer(id),
  season_id bigint not null references season(id), amount_cents bigint not null,
  kind text not null, ref_table text, ref_id bigint,
  notes text not null default '', created_by bigint, created_at text
);
create table if not exists delivery (
  id bigint primary key, code text not null unique,
  farmer_id bigint not null references farmer(id),
  contract_id bigint not null references contract(id),
  season_id bigint not null references season(id),
  location_id bigint not null references location(id),
  gross_g bigint not null, tare_g bigint not null default 0,
  net_g bigint generated always as (gross_g - tare_g) stored,
  delivered_on text not null, delivered_at text not null,
  vehicle_reg text not null default '', status text not null default 'Pending',
  notes text not null default '', created_by bigint, created_at text,
  check (tare_g < gross_g)
);
create table if not exists quality_test (
  id bigint primary key, code text not null unique,
  delivery_id bigint not null unique references delivery(id),
  moisture_bp int not null, oil_bp int not null, foreign_bp int not null,
  damage_bp int not null, grade text not null check (grade in ('A','B','C','REJECT')),
  tested_on text not null, tested_at text not null,
  notes text not null default '', created_by bigint, created_at text
);
create table if not exists settlement (
  id bigint primary key, code text not null unique,
  delivery_id bigint not null unique references delivery(id),
  farmer_id bigint not null references farmer(id),
  season_id bigint not null references season(id),
  price_schedule_id bigint not null references price_schedule(id),
  payable_g bigint not null, unit_price_cents bigint not null,
  gross_value_cents bigint not null, cess_cents bigint not null,
  recovery_cents bigint not null, recovery_cap text not null,
  net_payable_cents bigint not null, amount_paid_cents bigint not null default 0,
  balance_cents bigint not null, status text not null default 'Pending',
  computed_on text not null, computed_at text not null,
  approved_by bigint, approved_at text, notes text not null default '',
  created_by bigint, created_at text
);
create table if not exists payment (
  id bigint primary key, code text not null unique,
  settlement_id bigint not null references settlement(id),
  farmer_id bigint not null references farmer(id), amount_cents bigint not null,
  method text not null default 'M-Pesa', provider_ref text,
  idempotency_key text not null unique, status text not null default 'Pending',
  paid_on text, paid_at text, notes text not null default '', created_at text
);

-- --- the same invariants, restated in Postgres ----------------------------
create or replace function reject_write() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only or immutable: % rejected', tg_table_name, tg_op;
end $$;

do $$
declare t text;
begin
  foreach t in array array['stock_movement','ledger_entry','price_schedule'] loop
    execute format(
      'drop trigger if exists %I_no_change on %I;
       create trigger %I_no_change before update or delete on %I
       for each row execute function reject_write();', t, t, t, t);
  end loop;
end $$;

-- --- row level security ---------------------------------------------------
-- The service role key used by the push bypasses RLS. Everything else is denied
-- until you write a policy, which is the right default for farmer PII.
do $$
declare t text;
begin
  foreach t in array array['app_user','location','season','price_schedule','farmer',
                           'parcel','contract','item','lot','stock_movement',
                           'input_issue','ledger_entry','delivery','quality_test',
                           'settlement','payment'] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;
