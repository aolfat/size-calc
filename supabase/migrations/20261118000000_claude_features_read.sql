-- Trade features for a Claude session (docs/claude-access.md): the Claude key from Settings also reads every trade's
-- feature stamps (trade_features, docs/journal-features.md), so `node scripts/journal.mjs features` can put each trade's
-- result beside its features for analysis. Read only: stamps are worked out by the app and never written from here.
-- Its own function, not part of claude_journal_read, since stamps run a few KB a trade and only the features command
-- needs them.

create or replace function public.claude_features_read(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.claude_key_user(p_key);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('trade_key', f.trade_key, 'stamps', f.stamps))
    from public.trade_features f where f.user_id = uid), '[]');
end $$;

-- the same rights as the other Claude functions: a key in place of a sign-in (tests/rls.test.mjs)
revoke execute on function public.claude_features_read(text) from public;
grant execute on function public.claude_features_read(text) to anon, authenticated;
