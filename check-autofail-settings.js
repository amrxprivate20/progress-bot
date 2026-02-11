/**
 * Quick diagnostic script to check autofail settings
 * Run with: node check-autofail-settings.js
 */

// You'll need to set these environment variables:
// SUPABASE_URL, SUPABASE_ANON_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing environment variables!');
  console.log('Please set: SUPABASE_URL and SUPABASE_ANON_KEY');
  process.exit(1);
}

async function checkSettings() {
  const settingsToCheck = [
    'autofail_enabled',
    'autofail_hour',
    'autofail_time',  // Check both in case old name is still there
    'todoist_api_token',
    'telegram_chat_id',
  ];

  console.log('🔍 Checking autofail settings...\n');

  for (const key of settingsToCheck) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/settings?setting_key=eq.${key}`, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });

      const data = await response.json();

      if (data && data.length > 0) {
        const value = data[0].setting_value;
        // Mask sensitive values
        const displayValue = key.includes('token') || key.includes('api')
          ? `${value.substring(0, 8)}...`
          : value;
        console.log(`✅ ${key}: "${displayValue}"`);
      } else {
        console.log(`❌ ${key}: NOT SET`);
      }
    } catch (error) {
      console.error(`⚠️  ${key}: Error - ${error.message}`);
    }
  }

  // Also check current Egypt time
  console.log('\n⏰ Current Egypt time:');
  const egyptNow = new Date().toLocaleString('en-US', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  console.log(`   ${egyptNow}`);

  // Show time comparison logic
  const egyptDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  const egyptHour = egyptDate.getHours();
  const egyptMinute = egyptDate.getMinutes();
  const currentMinutes = egyptHour * 60 + egyptMinute;

  console.log(`\n📊 Time check logic:`);
  console.log(`   Current time: ${egyptHour}:${String(egyptMinute).padStart(2, '0')} (${currentMinutes} minutes)`);
  console.log(`   Default trigger: 23:00 (1380 minutes)`);
  console.log(`   Should trigger: ${currentMinutes >= 1380 ? 'YES ✅' : 'NO ❌'}`);
}

checkSettings().catch(console.error);
