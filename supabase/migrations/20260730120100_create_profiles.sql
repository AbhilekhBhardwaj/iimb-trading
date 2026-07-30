-- profiles — one row per authenticated competition participant.
-- Rows are provisioned server-side (service role) when accounts are created;
-- there are intentionally no client insert/update/delete policies.

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null unique,
  role          public.user_role not null,
  team_name     text,
  starting_cash numeric not null default 1000000
);

comment on table public.profiles is
  'Competition participants. Provisioned server-side only; clients may read (per RLS) but never write.';

-- ---------------------------------------------------------------------------
-- Role helper.
-- RLS policies on several tables need to know the *current* user's role.
-- Reading public.profiles directly inside a policy ON public.profiles would
-- recurse, so we wrap the lookup in a SECURITY DEFINER function. The function
-- is owned by the migration role (which owns profiles and does not force RLS),
-- so its internal read bypasses RLS and cannot recurse. STABLE + a pinned
-- search_path keep it safe to call from any policy.
-- ---------------------------------------------------------------------------
create function public.current_app_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid()
$$;

comment on function public.current_app_role() is
  'Returns the app role of the calling auth user. SECURITY DEFINER to avoid RLS recursion when used inside profiles policies.';

alter table public.profiles enable row level security;

-- SELECT: a normal team account may read only its own row (id = auth.uid()).
-- Privileged operators (master, market_maker) may read every profile — the
-- master runs the event and market makers need the participant roster to
-- quote against. This is the ONLY policy on profiles: with RLS enabled and no
-- INSERT/UPDATE/DELETE policy, all client writes are denied by default, while
-- the service-role key (used by provisioning) bypasses RLS entirely.
create policy "profiles_select_self_or_privileged"
  on public.profiles
  for select
  to authenticated
  using (
    id = auth.uid()
    or public.current_app_role() in ('master', 'market_maker')
  );
