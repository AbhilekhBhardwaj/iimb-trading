-- Tag notifications with the round that was active when they were pushed, so the
-- News page can organize Daily News per round (current + archive). Nullable:
-- items pushed with no active round (or event-wide announcements) stay untagged.
-- Plain text (not an FK) so clearing the rounds table doesn't constrain deletes.

alter table public.notifications
  add column round_id text;

comment on column public.notifications.round_id is
  'Round id active when this notification was pushed (rounds.id), or null. Drives per-round Daily News on the News page.';
