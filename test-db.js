require('dotenv').config({ path: 'artifacts/api-server/.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
  const { data: inv, error: invError } = await supabase.from('inventory').select('*').eq('service', 'netflix');
  console.log('Netflix inventory:', inv);
  const { data: ord, error: ordError } = await supabase.from('orders').select('*').ilike('items::text', '%netflix%').order('created_at', {ascending: false}).limit(2);
  console.log('Recent Netflix orders:', ord);
}
check();
