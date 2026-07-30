-- rounds — mirrors the engine Round type (packages/engine/src/rounds.ts).
-- id is TEXT (not uuid) so the engine's stable, human-meaningful round ids
-- (e.g. 'round-1') persist verbatim — far easier to eyeball while debugging a
-- live event than an opaque uuid. Written only by the engine service via the
-- service-role key.
--
-- Note: the engine's started_at/ended_at are event-clock *seconds* (number);
-- here we store wall-clock timestamptz per the schema spec, since the DB is
-- the record of when things actually happened.

create table public.rounds (
  id                 text primary key,
  index              integer not null,
  mode               public.round_mode not null,
  duration_seconds   integer not null,
  commission_enabled boolean not null default false,
  status             public.round_status not null default 'pending',
  started_at         timestamptz,
  ended_at           timestamptz
);

comment on table public.rounds is
  'Competition rounds, mirroring engine Round. Public read; written only by the engine (service role).';

alter table public.rounds enable row level security;

-- SELECT: round state (which round, its mode, its status) is public — every
-- client's UI reacts to it. Granted to anon and authenticated. No write
-- policies: only the engine service, holding the service-role key, drives
-- round transitions, so the round lifecycle can never be forged by a client.
create policy "rounds_public_read"
  on public.rounds
  for select
  to anon, authenticated
  using (true);
