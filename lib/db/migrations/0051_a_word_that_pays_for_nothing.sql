-- Promo codes: a plan given for a while, and the record of who was given one.
--
-- Nothing here touches money. A code names a plan and a number of months; the
-- account gets that plan with a date it runs out. A hundred per cent off is
-- the absence of a payment, which is a thing this database can express. A
-- partial discount is a rule about a charge, and the charge is not made here.
--
-- The two columns on `subscriptions` are the half that is easy to get wrong.
-- `plan_expires_at` is null for every row that exists today and must stay null
-- for every plan that was paid for: a date on a paying account is a customer
-- who silently drops to free while their card is still being charged.

create table if not exists promo_codes (
  -- Normalised on the way in: upper case, letters and digits only. The route
  -- normalises what a person types the same way, so `editly-year` and
  -- `EDITLYYEAR` are one code rather than one code and one support ticket.
  code             text primary key,
  plan             text        not null,
  months           integer     not null default 12,
  -- How many accounts may use it. One, unless somebody says otherwise: the use
  -- this was built for is a word handed to one affiliate.
  max_redemptions  integer     not null default 1,
  redeemed_count   integer     not null default 0,
  -- The last day it can be typed. Not the last day of what it gives: a code
  -- that closes at the end of a launch week still owes a year to everyone who
  -- used it during that week.
  expires_at       timestamptz,
  -- Withdrawn, not deleted. The redemptions under it stay readable.
  revoked_at       timestamptz,
  note             text        not null,
  created_by       uuid        not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists promo_codes_created_idx on promo_codes (created_at);

create table if not exists promo_redemptions (
  id               uuid primary key,
  code             text        not null,
  user_id          uuid        not null,
  -- What was granted, copied rather than joined. The answer has to survive the
  -- code being edited or revoked and the subscription moving on.
  plan             text        not null,
  grant_expires_at timestamptz not null,
  redeemed_at      timestamptz not null default now()
);

-- One account per code. The route checks first, for the better message; this
-- is what makes two simultaneous requests from one account impossible rather
-- than unlikely, inside the transaction that increments the count.
create unique index if not exists promo_redemptions_code_user_idx on promo_redemptions (code, user_id);
create index if not exists promo_redemptions_user_idx on promo_redemptions (user_id);

alter table subscriptions add column if not exists plan_expires_at timestamptz;
alter table subscriptions add column if not exists promo_code text;

-- Row-level security on both, and neither is reachable by a browser.
--
-- `promo_codes` has no owner at all: a code exists before anybody holds it,
-- which is the point of it. `promo_redemptions` has one, and the fence is
-- still not what protects it — the anon key never reaches either table, and
-- the redeem route runs as the app with the caller's id from a verified token.
--
-- They are switched on anyway, for the reason 0049 gives about a table with no
-- owner: the invariant is "every table in public has RLS enabled", not "every
-- table needs it", because a table somebody adds and forgets fails silently and
-- totally. A table that needs no fence proves it by carrying a policy that says
-- so out loud.
alter table promo_codes enable row level security;
alter table promo_redemptions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'promo_codes' and policyname = 'promo_codes_app'
  ) then
    execute 'create policy promo_codes_app on promo_codes for all to editly_app using (true) with check (true)';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'promo_redemptions' and policyname = 'promo_redemptions_app'
  ) then
    execute 'create policy promo_redemptions_app on promo_redemptions for all to editly_app using (true) with check (true)';
  end if;
end $$;

-- No DELETE, on either. A code is withdrawn by `revoked_at` and a redemption is
-- the record of what somebody was given; both have to outlive the decision that
-- made them, and a grant that can be deleted is a grant nobody can audit.
grant select, insert, update on promo_codes to editly_app;
grant select, insert on promo_redemptions to editly_app;
