// The claude-model-example Edge Function: a Claude key adds a Model books example with its screenshot (handler.js;
// docs/claude-access.md). Deploy: npx supabase functions deploy claude-model-example --no-verify-jwt (the Claude key
// stands in for a sign-in, so the gateway's JWT check stays off and the handler checks the key).
import { handle } from './handler.js';

Deno.serve(req => handle(req, { env: name => Deno.env.get(name) }));
