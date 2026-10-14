-- Delta imports: a fingerprint of each kept record (SHA-256 hex of its JSON with object keys sorted), so an import can
-- tell an order that changed from one that didn't and send only what's new or different. Rows saved before this have
-- none; the next import that sees them fills it in without counting them as changed.
alter table public.schwab_records add column fingerprint text
  check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$');
