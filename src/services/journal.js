// Journal reads: the signed-in account's kept Schwab records, newest first, from Supabase's schwab_records.
// Row-level security means only your own rows come back. Never touches the page.
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

/** how many records one read brings back; plenty for months of trading, raised once slices 2 to 4 need everything */
export const JOURNAL_READ_LIMIT = 5000;

/** @returns {Promise<{ kind: string, record_id: string, account: string, entered_at: string | null, data: any }[]>} */
export async function loadSavedRecords() {
  if (!state.session) throw new Error('Sign in with Google to see your journal.');
  const client = await supabaseClient();
  const res = await client.from('schwab_records').select('kind,record_id,account,entered_at,data')
    .order('entered_at', { ascending: false }).limit(JOURNAL_READ_LIMIT);
  if (res?.error) {
    const err = new Error(res.error.message || 'Supabase refused the read.');
    err.status = res.status || 0;
    throw err;
  }
  return res.data || [];
}
