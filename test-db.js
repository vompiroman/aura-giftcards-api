require('dotenv').config({ path: 'artifacts/api-server/.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
  const { data: inv, error: invError } = await supabase
    .from('inventory')
    .select('id, service, is_used, assigned_order_id, created_at')
    .eq('service', 'netflix');
  if (invError) throw invError;
  console.log('Netflix inventory summary:', { count: inv?.length || 0, rows: inv || [] });

  const { data: ord, error: ordError } = await supabase
    .from('orders')
    .select('order_id, status, payment_status, amount, created_at')
    .order('created_at', {ascending: false})
    .limit(2);
  if (ordError) throw ordError;
  console.log('Recent order summary:', { count: ord?.length || 0, rows: ord || [] });
}
check().catch((error) => { console.error('Diagnostic failed:', error?.message || 'unknown error'); process.exitCode = 1; });
