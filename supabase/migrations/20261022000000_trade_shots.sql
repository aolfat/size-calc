-- Journal step 3, slice 1 (docs/journal-step-3.md): screenshots on a trade. The images live in a private Storage bucket,
-- each under a folder named for its owner (<user id>/<shot id>.webp), so the storage rules below let a user reach only
-- their own files; this table says which trade each one belongs to. The app shrinks images before they're sent (at most
-- 2000px, WebP or JPEG) and shows them through short-lived signed links, never public ones.

create table if not exists public.trade_shots (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  trade_key text not null check (length(trade_key) between 1 and 200),
  path text not null check (length(path) between 1 and 200), -- <user id>/<id>.<ext> in the trade-shots bucket
  caption text check (length(caption) <= 300),
  width integer check (width is null or width between 1 and 10000),
  height integer check (height is null or height between 1 and 10000),
  bytes integer check (bytes is null or bytes between 1 and 2097152),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists trade_shots_trade on public.trade_shots (user_id, trade_key);

alter table public.trade_shots enable row level security;

drop policy if exists trade_shots_owner on public.trade_shots;
create policy trade_shots_owner on public.trade_shots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.trade_shots from anon;
grant select, insert, update, delete on public.trade_shots to authenticated;

-- the bucket: private, images only, 2 MB a file
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-shots', 'trade-shots', false, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- a user reaches only the files in their own folder of that bucket
drop policy if exists trade_shots_files_owner on storage.objects;
create policy trade_shots_files_owner on storage.objects for all to authenticated
  using (bucket_id = 'trade-shots' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'trade-shots' and (storage.foldername(name))[1] = (select auth.uid())::text);
