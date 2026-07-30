-- notifications — the event-wide message feed behind the terminal's bottom
-- strip (Announcement / Daily News / Data) and the announcement popup overlay.
-- Written by the Master Terminal / engine (service role); every participant
-- reads them. This is the display source; the Master Terminal that pushes them
-- is the next build step.

create type public.notification_kind as enum ('announcement', 'daily_news', 'data');

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  kind       public.notification_kind not null,
  title      text not null,
  body       text,
  created_at timestamptz not null default now()
);

comment on table public.notifications is
  'Event-wide messages for the terminal strip + announcement popups. Public read; written server-side (Master Terminal).';

create index notifications_created_at_idx on public.notifications (created_at desc);

alter table public.notifications enable row level security;

-- SELECT: notifications are broadcast to everyone in the event — every team,
-- market maker, and master needs to see announcements/news/data. Granted to
-- anon and authenticated. No write policies: only the service role (Master
-- Terminal) publishes, so messages can't be forged by a client.
create policy "notifications_public_read"
  on public.notifications
  for select
  to anon, authenticated
  using (true);