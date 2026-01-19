# Progress Bot

A comprehensive Telegram bot for personal productivity tracking, integrating Todoist task management with AI-powered insights, journaling, and weekly goal generation.

## Features

### Core Features
- **Todoist Integration**: Automatic tracking of completed tasks via webhooks
- **AI-Powered Reports**: Daily progress reports with personalized commentary
- **Streak Tracking**: Monitor consistency with task completion streaks
- **Arabic Language Support**: Full RTL support with proper pluralization

### Phase 3 Features
- **Journal System**: Daily journaling with text, images, videos, and documents
- **Weekly Goals Generation**: AI-powered goal creation with daily challenges
- **Todoist Task Creation**: Convert weekly goals into actionable Todoist tasks
- **Google Drive Integration**: Auto-save reports as markdown files

---

## Quick Start

### Prerequisites

- Node.js v18+
- Cloudflare Account (free tier)
- Supabase Account (free tier)
- Todoist Account
- Telegram Account
- OpenRouter API Key (for AI features)

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd progress-bot

# Install dependencies
npm install

# Configure environment variables
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your credentials

# Run locally
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

### Environment Variables

Create a `.dev.vars` file:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
TODOIST_API_TOKEN=your_todoist_api_token
```

---

## Bot Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot |
| `/progress` | Preview today's progress report |
| `/confirm` | Generate full AI-powered report |
| `/today` | Quick view of today's completed tasks |
| `/report [date]` | View a specific day's report |
| `/lastupdate` | Show last report date and active streaks |

### Journal Commands

| Command | Description |
|---------|-------------|
| `/journal_start` | Start a daily journaling session |
| `/journal_end` | End the current journal session |
| `/journal_resume` | Resume a closed journal session |

### Goals & Tasks

| Command | Description |
|---------|-------------|
| `/goals` | View current week's goals and daily challenge |
| `/generate_goals` | Generate new weekly goals (best on Fridays) |
| `/createtasks` | Create Todoist tasks from weekly goals |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/logfailure` | Log a failed task with reason |
| `/memory` | View conversation memory/context |
| `/clearmemory` | Clear conversation memory |
| `/sync` | Force sync completed tasks from Todoist |

---

## Architecture

```
progress-bot/
├── src/
│   ├── index.ts              # Main worker entry point
│   ├── bot/
│   │   └── grammy.ts         # Telegram bot setup
│   ├── database/
│   │   ├── client.ts         # Supabase client
│   │   ├── schema.sql        # Database schema
│   │   └── settings.ts       # Settings management
│   ├── durable-objects/
│   │   └── report-processor.ts  # Background AI processing
│   ├── handlers/
│   │   ├── todoist.ts        # Todoist webhook handler
│   │   └── telegram.ts       # Telegram handlers
│   ├── services/
│   │   ├── ai-client.ts      # OpenRouter AI client
│   │   ├── google-drive.ts   # Google Drive integration
│   │   ├── goals-manager.ts  # Weekly goals system
│   │   ├── journal.ts        # Journal system
│   │   ├── report-generator.ts  # Report generation
│   │   └── todoist-client.ts # Todoist task creation
│   ├── types/
│   │   └── index.ts          # TypeScript interfaces
│   └── utils/
│       ├── errors.ts         # Error handling
│       ├── timezone.ts       # Egypt timezone utilities
│       └── validation.ts     # Input validation
├── database/
│   └── migration_phase3.sql  # Phase 3 migration script
├── wrangler.toml             # Cloudflare Worker config
└── package.json
```

---

## Database Schema

### Core Tables

- **tasks**: Completed task records from Todoist
- **daily_reports**: Generated AI reports
- **task_failures**: Logged failed/incomplete tasks
- **streaks**: Task completion streaks
- **settings**: Configuration key-value store
- **conversation_states**: Bot conversation context

### Phase 3 Tables

- **journal_entries**: Daily journal entries with media support
- **weekly_goals**: AI-generated weekly goals
- **daily_challenges**: Daily challenges for each day of the week

---

## Settings Configuration

Configure these in your Supabase `settings` table:

| Key | Description | Required |
|-----|-------------|----------|
| `openrouter_api_key` | OpenRouter API key for AI | Yes |
| `todoist_api_token` | Todoist API token | Yes |
| `todoist_project_id` | Todoist project ID for tasks | Yes |
| `google_drive_folder_id` | Google Drive folder for reports | Optional |
| `google_service_account` | Service account JSON credentials | Optional |
| `strategic_goals` | Long-term goals for AI context | Optional |

---

## Phase Guides

- **[Phase 1 Guide](README_PHASE1.md)**: Foundation setup (database, webhooks, basic bot)
- **[Phase 3 Deployment](DEPLOYMENT_GUIDE_PHASE3.md)**: Journal, goals, Todoist, Drive setup
- **[Phase 3 Testing](TESTING_PHASE3.md)**: Comprehensive testing procedures

---

## Daily Workflow

### Morning
1. `/journal_start` - Begin journaling
2. Send morning reflections (text, photos)
3. `/goals` - Check today's challenge

### Throughout Day
- Complete tasks in Todoist (auto-tracked)
- Send journal entries as desired

### Evening
1. `/journal_end` - Close journal session
2. `/progress` - Preview day summary
3. `/confirm` - Generate AI report

### Weekly Planning (Fridays)
1. `/goals` - Review current week
2. `/generate_goals` - Generate next week's goals
3. `/createtasks` - Create Todoist tasks

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/telegram/webhook` | POST | Telegram bot webhook |
| `/webhook/todoist` | POST | Todoist webhook for task completion |
| `/health` | GET | Health check endpoint |

---

## Technical Details

### Timezone
All dates use Egypt timezone (UTC+2). The `getTodayInEgypt()` utility handles all date operations.

### AI Integration
Uses OpenRouter API with Claude Sonnet 4 for:
- Daily report commentary
- Weekly goals generation
- Task extraction from goals

### Rate Limits
- Todoist API: 450 requests per 15 minutes
- OpenRouter: Based on your plan
- Telegram: Standard bot limits apply

### Error Handling
- Automatic retry with exponential backoff
- Non-fatal errors logged but don't interrupt workflow
- Google Drive failures don't block report generation

---

## Deployment

### Cloudflare Workers

```bash
# Set secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TODOIST_API_TOKEN

# Deploy
npm run deploy
```

### Set Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-worker.workers.dev/telegram/webhook"
```

### Set Todoist Webhook

1. Go to [Todoist Developer Console](https://developer.todoist.com/)
2. Create an app
3. Add webhook: `https://your-worker.workers.dev/webhook/todoist`

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Bot not responding | Check Telegram webhook URL |
| Tasks not syncing | Verify Todoist webhook configuration |
| AI errors | Check OpenRouter API key and balance |
| Drive not saving | Verify folder ID and service account access |

### Debugging

```bash
# View live logs
wrangler tail

# Check database
# Use Supabase SQL Editor
SELECT * FROM tasks ORDER BY completed_at DESC LIMIT 10;
```

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Test locally with `npm run dev`
5. Submit a pull request

---

## License

MIT License - See LICENSE file for details.

---

## Support

If you encounter issues:
1. Check the troubleshooting section
2. Review Cloudflare Worker logs
3. Check Supabase logs
4. Verify all environment variables

---

**Built with Cloudflare Workers, Grammy, Supabase, and OpenRouter AI**
