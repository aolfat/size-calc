// Order plans reads and writes (order_plans; docs/schwab.md, docs/journal.md): saved whole by id after an order goes, read
// for the journal, and looked up by an order id when Positions' Edit gives the entry a new one. Row-level security
// returns only your rows. Never touches the page.
import { cleanPlanRow } from '../core/order-plans.js';
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

const COLUMNS = 'id,account,symbol,side,order_ids,sent_at,setups,tactics,setup_grade,plan,trade_key';
const notPushed = (/** @type {any} */ res) => res?.error && /schema cache|does not exist/i.test(res.error.message || '');
/** the setup_grade column isn't in the database yet (its migration not pushed): the rest still reads and saves without it */
const noGrade = (/** @type {any} */ res) => notPushed(res) && /setup_grade/.test(res.error.message || '');
const withoutGrade = (/** @type {Record<string, any>} */ row) => { const { setup_grade, ...rest } = row; return rest; };
const OLD_COLUMNS = COLUMNS.replace('setup_grade,', '');
/** the rest saved without the grade: a grade that was picked says it wasn't kept (gradeOnly: the plan itself was) */
function gradeLost(res, row) {
  if (res?.error || !row.setup_grade) return;
  throw Object.assign(new Error("the database doesn't have order_plans.setup_grade yet: npx supabase db push"), { gradeOnly: true });
}

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
  let res = await c.from('order_plans').upsert([row], { onConflict: 'user_id,id' });
  if (noGrade(res)) { res = await c.from('order_plans').upsert([withoutGrade(row)], { onConflict: 'user_id,id' }); gradeLost(res, row); }
  refused(res, 'Supabase refused the save.');
}

/** some of a plan's columns: the picks changed after Place, the trade its labels went on, an Edit's new order id */
export async function updateOrderPlan(id, fields) {
  const c = await client();
  let res = await c.from('order_plans').update(fields).eq('id', id);
  if (noGrade(res)) { res = await c.from('order_plans').update(withoutGrade(fields)).eq('id', id); gradeLost(res, fields); }
  refused(res, 'Supabase refused the save.');
}

/** every plan, cleaned (core/order-plans.js cleanPlanRow) */
export async function loadOrderPlans() {
  const c = await client();
  let res = await c.from('order_plans').select(COLUMNS).limit(5000);
  if (noGrade(res)) res = await c.from('order_plans').select(OLD_COLUMNS).limit(5000);
  refused(res, 'Supabase refused the read.');
  return (res.data || []).map(cleanPlanRow).filter(Boolean);
}

/** the plan an order id belongs to, or null (none, or not signed in) */
export async function planWithOrder(orderId) {
  if (!state.session || !orderId) return null;
  const c = await supabaseClient();
  let res = await c.from('order_plans').select(COLUMNS).contains('order_ids', [String(orderId)]).limit(1);
  if (noGrade(res)) res = await c.from('order_plans').select(OLD_COLUMNS).contains('order_ids', [String(orderId)]).limit(1);
  refused(res, 'Supabase refused the read.');
  return (res.data || []).map(cleanPlanRow).find(Boolean) || null;
}
