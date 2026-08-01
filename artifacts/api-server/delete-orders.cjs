const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Parse .env manually
const envFile = fs.readFileSync('.env', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
});

if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
  console.error("Missing SUPABASE variables in .env");
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' || process.env.ALLOW_ORDER_WIPE !== 'true' || process.env.WIPE_CONFIRM !== 'DELETE_ALL_ORDERS') {
  console.error('Refusing destructive order wipe. Use a non-production environment with ALLOW_ORDER_WIPE=true and WIPE_CONFIRM=DELETE_ALL_ORDERS.');
  process.exit(1);
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

async function wipe() {
  console.log("Deleting all orders...");
  const { data, error } = await supabase.from('orders').delete().neq('order_id', 'NON_EXISTENT_ID');
  console.log('Deleted orders:', error || "Success");
}
wipe();
