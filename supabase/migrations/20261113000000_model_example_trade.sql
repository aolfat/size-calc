-- Model books from a trade (docs/journal.md): Add to model book on a Journal trade page keeps one of the trade's
-- screenshots as an example, copied into the model-books bucket, and says which trade it came from. trade_key is the
-- journal's trade key, the same one trade_shots and trade_reviews use; null for an example pasted in Model books. It's
-- a plain reference, not a foreign key: a trade deleted from the journal leaves its examples where they are.
alter table public.model_examples add column if not exists trade_key text
  check (trade_key is null or length(trade_key) between 1 and 200);
create index if not exists model_examples_trade on public.model_examples (user_id, trade_key) where trade_key is not null;
