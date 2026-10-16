-- Personal model books with pasted chart screenshots. Setup tags store the existing library's stable keys.
create table if not exists public.model_books (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 4000),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.model_examples (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  book_id uuid not null,
  title text not null check (length(trim(title)) between 1 and 120),
  notes text not null default '' check (length(notes) <= 4000),
  setup_keys text[] not null default '{}' check (cardinality(setup_keys) <= 100),
  path text not null check (length(path) between 1 and 200 and split_part(path, '/', 1) = user_id::text),
  width integer not null check (width between 1 and 10000),
  height integer not null check (height between 1 and 10000),
  bytes integer not null check (bytes between 1 and 2097152),
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, book_id) references public.model_books (user_id, id)
);
create index if not exists model_examples_book on public.model_examples (user_id, book_id, created_at desc);

alter table public.model_books enable row level security;
alter table public.model_examples enable row level security;
drop policy if exists model_books_owner on public.model_books;
create policy model_books_owner on public.model_books for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists model_examples_owner on public.model_examples;
create policy model_examples_owner on public.model_examples for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.model_books, public.model_examples from anon;
grant select, insert, update, delete on public.model_books, public.model_examples to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('model-books', 'model-books', false, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists model_books_files_owner on storage.objects;
create policy model_books_files_owner on storage.objects for all to authenticated
  using (bucket_id = 'model-books' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'model-books' and (storage.foldername(name))[1] = (select auth.uid())::text);
