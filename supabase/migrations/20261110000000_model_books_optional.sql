-- Model books (docs/journal-step-3.md): an example's book is optional. You look charts up by setup, so a chart can be
-- kept with just its setup tags; books stay for when you want a collection of your own. An example with no book has a
-- null book_id, which the (user_id, book_id) foreign key lets through (a null key isn't checked), and a book still
-- can't be deleted while examples are in it.
alter table public.model_examples alter column book_id drop not null;
