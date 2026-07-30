-- event_log — append-only live-debugging feed.
-- The engine/server writes a row for every notable event so that, during the
-- live competition, the master can answer "what just happened to user X?" and
-- "what is the system doing right now?" without shelling into logs.

create table public.event_log (
  id         uuid primary key default gen_random_uuid(),
  -- Nullable on purpose: system-level events (round_started, generic errors)
  -- are not tied to any single account.
  account_id uuid references public.profiles (id) on delete set null,
  event_type text not null, -- e.g. 'order_placed','order_matched','order_rejected','round_started','round_ended','error'
  payload    jsonb not null default '{}'::jsonb, -- flexible per-event structured detail
  severity   public.event_severity not null default 'info',
  created_at timestamptz not null default now()
);

comment on table public.event_log is
  'Append-only diagnostic feed written by the engine/server. Master reads all; a user reads only its own events.';

-- Debugging queries during the event are "everything for user X in the last N
-- minutes", so index both dimensions we filter on.
create index event_log_account_id_idx on public.event_log (account_id);
create index event_log_created_at_idx on public.event_log (created_at desc);

alter table public.event_log enable row level security;

-- SELECT: the master role (running the event) may read every log row, including
-- system-level ones where account_id is null. A normal account may read only
-- rows tagged with its own id — a team can review its own activity without
-- seeing anyone else's, and cannot see null-account system events. No write
-- policies: only the engine/server (service role) appends here, keeping the
-- audit trail trustworthy.
create policy "event_log_select_master_or_own"
  on public.event_log
  for select
  to authenticated
  using (
    public.current_app_role() = 'master'
    or account_id = auth.uid()
  );
