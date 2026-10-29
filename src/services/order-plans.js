// Order plans reads and writes (order_plans; docs/schwab.md, docs/journal.md): saved whole by id after an order goes, read
// for the journal, and looked up by an order id when Positions' Edit gives the entry a new one. Row-level security
// returns only your rows. Never touches the page.
import { cleanPlanRow } from '../core/order-plans.js';
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

const COLUMNS = 'id,account,symbol,side,order_ids,sent_at,setups,tactics,plan,trade_key';
const notPushed = (/** @type {any} */ res) => res?.error && /schema cache|does not exist/i.test(res.error.message || '');

function refused(res, what) {
  if (!res?.error) return;
  const err = new Error(notPushed(res) ? "the database doesn't have the order_plans table yet: npx supabase db push" : res.error.message || what);
  err.status = res.status || 0;
  throw err;
}

async function client() {
  if (!state.session) throw new Error('Sign in with Google to keep order plans.');
  return supabaseClient();
}

/** one plan, whole (its id is made in the browser, so a second save of the same order updates it) */
export async function saveOrderPlan(row) {
  const c = await client();
  refused(await c.from('order_plans').upsert([row], { onConflict: 'user_id,id' }), 'Supabase refused the save.');
}

/** some of a plan's columns: the picks changed after Place, the trade its labels went on, an Edit's new order id */
export async function updateOrderPlan(id, fields) {
  const c = await client();
  refused(await c.from('order_plans').update(fields).eq('id', id), 'Supabase refused the save.');
}

/** every plan, cleaned (core/order-plans.js cleanPlanRow) */
export async function loadOrderPlans() {
  const c = await client();
  const res = await c.from('order_plans').select(COLUMNS).limit(5000);
  refused(res, 'Supabase refused the read.');
  return (res.data || []).map(cleanPlanRow).filter(Boolean);
}

/** the plan an order id belongs to, or null (none, or not signed in) */
export async function planWithOrder(orderId) {
  if (!state.session || !orderId) return null;
  const c = await supabaseClient();
  const res = await c.from('order_plans').select(COLUMNS).contains('order_ids', [String(orderId)]).limit(1);
  refused(res, 'Supabase refused the read.');
  return (res.data || []).map(cleanPlanRow).find(Boolean) || null;
}
