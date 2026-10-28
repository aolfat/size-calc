-- Claude access to Model books (docs/claude-access.md): the Claude key from Settings also reads your books and examples,
-- makes and renames books, and edits an example's title, notes, setups and book. A new example comes with its screenshot,
-- which goes to Storage, and SQL can't upload a file: the claude-model-example Edge Function (supabase/functions/) checks
-- the image, adds the row through claude_model_example_add, the one function only the service role may run, and uploads
-- the file to the owner's folder. Nothing here deletes a book or an example; that stays in the app.

create or replace function public.claude_model_books_read(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.claude_key_user(p_key);
begin
  return jsonb_build_object(
    'books', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'description', b.description,
        'created_at', b.created_at) order by b.created_at)
      from public.model_books b where b.user_id = uid), '[]'),
    'examples', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'book_id', e.book_id, 'title', e.title,
        'notes', e.notes, 'setup_keys', to_jsonb(e.setup_keys), 'width', e.width, 'height', e.height, 'bytes', e.bytes,
        'created_at', e.created_at) order by e.created_at desc)
      from public.model_examples e where e.user_id = uid), '[]'),
    'library', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'name', i.name,
        'default_key', i.default_key, 'hidden', i.hidden, 'merged_into', i.merged_into, 'settings', i.settings))
      from public.library_items i where i.user_id = uid), '[]')
  );
end $$;

-- p_changes: { books: [{ id, name, description }] (new or renamed), examples: [{ id, fields: { book_id, title, notes,
-- setup_keys } }] (only the fields sent change) }, all in one transaction. An example has to exist already: new ones
-- come through the Edge Function with their screenshot.
create or replace function public.claude_model_books_save(p_key text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.claude_key_user(p_key);
  r jsonb;
  f jsonb;
  n int := 0;
begin
  if jsonb_typeof(p_changes) is distinct from 'object' or octet_length(p_changes::text) > 100000 then
    raise exception 'changes: one object, 100 KB at most';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'books', '[]')) loop
    insert into public.model_books (user_id, id, name, description)
      values (uid, (r->>'id')::uuid, trim(r->>'name'), coalesce(r->>'description', ''))
      on conflict (user_id, id) do update set name = excluded.name, description = excluded.description;
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'examples', '[]')) loop
    f := coalesce(r->'fields', '{}');
    if exists (select 1 from jsonb_object_keys(f) k where k not in ('book_id', 'title', 'notes', 'setup_keys')) then
      raise exception 'example fields: book_id, title, notes, setup_keys';
    end if;
    update public.model_examples e set
      book_id = case when f ? 'book_id' then (f->>'book_id')::uuid else e.book_id end,
      title = case when f ? 'title' then trim(f->>'title') else e.title end,
      notes = case when f ? 'notes' then coalesce(f->>'notes', '') else e.notes end,
      setup_keys = case when f ? 'setup_keys'
        then array(select jsonb_array_elements_text(coalesce(nullif(f->'setup_keys', 'null'::jsonb), '[]'))) else e.setup_keys end
      where e.user_id = uid and e.id = (r->>'id')::uuid;
    if not found then raise exception 'no example %', r->>'id'; end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

-- p_example: { book_id, title, notes, setup_keys, ext, width, height, bytes }, from the Edge Function once it has read
-- the image itself. The row lands in the key owner's book with the path the app uses (<owner>/<id>.<ext>); the function
-- then uploads the file there, and takes the row back if Storage refuses it.
create or replace function public.claude_model_example_add(p_key text, p_example jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.claude_key_user(p_key);
  e jsonb := coalesce(p_example, '{}');
  new_id uuid := gen_random_uuid();
  new_path text;
begin
  if coalesce(e->>'ext', '') not in ('png', 'jpg', 'webp') then raise exception 'image: png, jpg or webp'; end if;
  new_path := uid::text || '/' || new_id::text || '.' || (e->>'ext');
  insert into public.model_examples (user_id, id, book_id, title, notes, setup_keys, path, width, height, bytes)
    values (uid, new_id, (e->>'book_id')::uuid, trim(e->>'title'), coalesce(e->>'notes', ''),
      array(select jsonb_array_elements_text(coalesce(nullif(e->'setup_keys', 'null'::jsonb), '[]'))),
      new_path, (e->>'width')::int, (e->>'height')::int, (e->>'bytes')::int);
  return jsonb_build_object('user_id', uid, 'id', new_id, 'path', new_path);
end $$;

-- read and save take a key in place of a sign-in, like the journal's two; the add is the Edge Function's alone
-- (tests/rls.test.mjs checks both, and that each starts by checking the key)
revoke execute on function public.claude_model_books_read(text), public.claude_model_books_save(text, jsonb) from public;
grant execute on function public.claude_model_books_read(text), public.claude_model_books_save(text, jsonb) to anon, authenticated;
revoke execute on function public.claude_model_example_add(text, jsonb) from public, anon, authenticated;
grant execute on function public.claude_model_example_add(text, jsonb) to service_role;
