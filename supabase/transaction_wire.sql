-- Additive: no changes to leagues, history, OAuth, or notification tables.
-- Apply once in the Supabase SQL editor before enabling the new routes.
create table if not exists public.fsn_transaction_state (
  scope text primary key,
  revision bigint not null default 0,
  observed_at timestamptz not null,
  injuries jsonb not null default '{}'::jsonb
);
create table if not exists public.fsn_transaction_articles (
  scope text not null,
  id text not null,
  source_event_id text not null,
  category text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  article jsonb not null,
  primary key(scope,id)
);
create index if not exists fsn_transaction_articles_time on public.fsn_transaction_articles(scope,occurred_at desc);
alter table public.fsn_transaction_state enable row level security;
alter table public.fsn_transaction_articles enable row level security;
revoke all on public.fsn_transaction_state, public.fsn_transaction_articles from anon, authenticated;
grant all on public.fsn_transaction_state, public.fsn_transaction_articles to service_role;

-- One atomic commit: the injury baseline cannot advance unless every article
-- is inserted. A concurrent run with an obsolete baseline must retry. Existing
-- articles are immutable even when later roster/record observations differ.
create or replace function public.fsn_commit_transaction_wire(
  p_scope text, p_revision bigint, p_observed_at timestamptz,
  p_injuries jsonb, p_articles jsonb
) returns boolean language plpgsql security invoker set search_path=public as $$
declare current_revision bigint; item jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scope, 0));
  select revision into current_revision from public.fsn_transaction_state where scope=p_scope;
  if coalesce(current_revision,0) <> p_revision then return false; end if;
  if jsonb_typeof(p_articles) <> 'array' or jsonb_typeof(p_injuries) <> 'object' then
    raise exception 'Invalid transaction commit';
  end if;
  for item in select value from jsonb_array_elements(p_articles) loop
    if item->>'articleType' <> 'transaction_wire' or
       concat(item->>'provider',':',item->>'leagueId',':',item->>'season') <> p_scope then
      raise exception 'Transaction article scope mismatch';
    end if;
    insert into public.fsn_transaction_articles(scope,id,source_event_id,category,occurred_at,article)
    values(p_scope,item->>'id',item->>'sourceEventId',item->>'topic',to_timestamp((item->>'at')::double precision/1000),item)
    on conflict(scope,id) do nothing;
  end loop;
  insert into public.fsn_transaction_state(scope,revision,observed_at,injuries)
  values(p_scope,p_revision+1,p_observed_at,p_injuries)
  on conflict(scope) do update set revision=excluded.revision,observed_at=excluded.observed_at,injuries=excluded.injuries;
  return true;
end;
$$;
revoke all on function public.fsn_commit_transaction_wire(text,bigint,timestamptz,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fsn_commit_transaction_wire(text,bigint,timestamptz,jsonb,jsonb) to service_role;
