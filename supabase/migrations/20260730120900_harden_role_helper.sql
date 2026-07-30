-- Hardening: take current_app_role() out of the PostgREST-exposed API surface.
--
-- The security advisor (lints 0028/0029) flagged that a SECURITY DEFINER
-- function living in `public` is callable by anon/authenticated as an RPC
-- (/rest/v1/rpc/current_app_role). The function only ever returns the CALLER'S
-- OWN role, so it leaks nothing — but there is no reason to expose it as an
-- endpoint. Moving it to a non-exposed `private` schema removes it from the API
-- while the RLS policies that reference it keep working (they bind the function
-- by OID, not by qualified name). Only `authenticated` evaluates those policies
-- (all role-gated policies are `to authenticated`), so EXECUTE is granted there
-- and revoked from everyone else.

create schema if not exists private;

alter function public.current_app_role() set schema private;

revoke all on function private.current_app_role() from public;
grant execute on function private.current_app_role() to authenticated;
