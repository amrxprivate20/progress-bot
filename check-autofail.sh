#!/bin/bash
# Quick diagnostic script for autofail setup

echo "🔍 Auto-Fail Diagnostic Check"
echo "=============================="
echo ""

# Load environment variables
if [ -f .dev.vars ]; then
    source .dev.vars
    echo "✅ Loaded .dev.vars"
else
    echo "❌ .dev.vars not found"
    exit 1
fi

# Check Supabase settings
echo ""
echo "📋 Checking Supabase Settings..."
echo "--------------------------------"

check_setting() {
    key=$1
    result=$(curl -s "${SUPABASE_URL}/rest/v1/settings?key=eq.${key}" \
        -H "apikey: ${SUPABASE_ANON_KEY}" \
        -H "Authorization: Bearer ${SUPABASE_ANON_KEY}")

    if echo "$result" | grep -q "\"key\":\"${key}\""; then
        value=$(echo "$result" | grep -o "\"value\":\"[^\"]*\"" | cut -d'"' -f4)
        if [[ $key == *"token"* ]] || [[ $key == *"api"* ]]; then
            echo "✅ ${key}: ${value:0:8}..."
        else
            echo "✅ ${key}: ${value}"
        fi
        return 0
    else
        echo "❌ ${key}: NOT SET"
        return 1
    fi
}

check_setting "autofail_enabled"
check_setting "autofail_hour"
check_setting "todoist_api_token"
check_setting "telegram_chat_id"

# Check current time
echo ""
echo "⏰ Time Check..."
echo "--------------------------------"
egypt_time=$(node -e "console.log(new Date().toLocaleString('en-US', {timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false}))")
utc_time=$(node -e "console.log(new Date().toLocaleString('en-US', {timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false}))")
echo "Egypt time: ${egypt_time}"
echo "UTC time: ${utc_time}"
echo "Trigger time: 23:30 Egypt"

# Extract hour and minute
egypt_hour=$(echo $egypt_time | cut -d':' -f1)
egypt_min=$(echo $egypt_time | cut -d':' -f2)
egypt_minutes=$((10#$egypt_hour * 60 + 10#$egypt_min))
trigger_minutes=$((23 * 60 + 30))

if [ $egypt_minutes -ge $trigger_minutes ]; then
    echo "✅ Current time >= trigger time (should run)"
else
    echo "⏭️ Current time < trigger time (will not run yet)"
    remaining=$((trigger_minutes - egypt_minutes))
    echo "   Time until trigger: ${remaining} minutes"
fi

# Check Worker deployment
echo ""
echo "☁️ Cloudflare Worker..."
echo "--------------------------------"
if command -v wrangler &> /dev/null; then
    echo "✅ Wrangler CLI installed"
    worker_status=$(npx wrangler deployments list 2>&1 | head -5)
    if echo "$worker_status" | grep -q "Created:"; then
        echo "✅ Worker is deployed"
    else
        echo "⚠️ Worker deployment status unclear"
    fi
else
    echo "⚠️ Wrangler CLI not found"
fi

# Check GitHub workflow
echo ""
echo "🔄 GitHub Actions Workflow..."
echo "--------------------------------"
if [ -f .github/workflows/autofail.yml ]; then
    echo "✅ Workflow file exists"
    cron_schedule=$(grep "cron:" .github/workflows/autofail.yml | head -2 | tail -1 | cut -d"'" -f2)
    echo "   Schedule: ${cron_schedule}"
else
    echo "❌ Workflow file not found"
fi

echo ""
echo "⚠️ IMPORTANT: Check GitHub Secrets"
echo "Go to: https://github.com/amrxprivate20/progress-bot/settings/secrets/actions"
echo "Required secrets:"
echo "  - AUTOFAIL_SECRET"
echo "  - WORKER_URL"
echo ""
echo "📖 See AUTOFAIL_SETUP_GUIDE.md for detailed instructions"
