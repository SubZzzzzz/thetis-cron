# thetis-cron

Scheduled task runner for [Pi](https://github.com/earendil-works/pi) — cron jobs with delivery to Discord, ntfy, and more.

Part of the [Thetis extensions](https://github.com/SubZzzzzz) ecosystem for Pi.

## Features

- **Cron job management** via Pi tool or `/cron` command
- **Two execution modes:**
  - `script` — execute shell commands (no LLM cost)
  - `agent` — run prompts through Pi (`pi -p "prompt"`)
- **Delivery options:**
  - ntfy (push notifications)
  - Discord webhooks (with user pings)
- **Persistent job storage** in `~/.pi/agent/cron/<job-id>/`
- **Background scheduler** daemon (systemd service or manual)
- **Natural language schedules** (`every 5m`, `every 2h`, `every day at 09:00`)

## Installation

```bash
pi install git:github.com/SubZzzzzz/thetis-cron
```

Or install locally:

```bash
pi install /path/to/thetis-cron
```

Then reload Pi:

```bash
/reload
```

## Usage

### Create a job

Ask Pi to create a cron job:

```
Create a cron job called "email-monitor" that runs every 5 minutes and checks for new emails from achille.robbe123@gmail.com
```

Or use the tool directly:

```
cron(action="create", id="email-monitor", schedule="every 5m", mode="script", prompt="python3 ~/check_emails.py", delivery={ntfy: "https://ntfy.sh/my-topic", discord_webhook: "https://discord.com/api/webhooks/..."})
```

### List jobs

```
cron(action="list")
```

Or via command:

```
/cron list
```

### Manage jobs

```
cron(action="pause", id="email-monitor")
cron(action="resume", id="email-monitor")
cron(action="edit", id="email-monitor", schedule="every 10m")
cron(action="run", id="email-monitor")  # Force immediate execution
cron(action="remove", id="email-monitor")
```

### Check status

```
cron(action="status")
```

Or via command:

```
/cron status
```

## Job Structure

Each job is stored in `~/.pi/agent/cron/<job-id>/`:

```
~/.pi/agent/cron/
├── email-monitor/
│   ├── job.json        # Config: schedule, mode, delivery, etc.
│   ├── prompt.md       # The prompt or script to execute
│   ├── state.json      # Runtime state: last_run, next_run, run_count
│   └── output/         # Execution logs
│       ├── 2025-01-15T09-00-00.log
│       └── 2025-01-15T09-05-00.log
└── daily-digest/
    ├── job.json
    ├── prompt.md
    └── ...
```

### job.json

```json
{
  "id": "email-monitor",
  "name": "Email Monitor",
  "schedule": "*/5 * * * *",
  "schedule_human": "every 5m",
  "mode": "script",
  "enabled": true,
  "delivery": {
    "ntfy": "https://ntfy.sh/my-topic",
    "discord_webhook": "https://discord.com/api/webhooks/...",
    "discord_ping": "254309570804056064"
  },
  "created_at": "2025-01-15T08:00:00Z",
  "updated_at": "2025-01-15T08:00:00Z"
}
```

### prompt.md

For `mode: "script"`:

```bash
#!/bin/bash
python3 ~/check_emails.py
```

For `mode: "agent"`:

```
Check for new emails from achille.robbe123@gmail.com and summarize any important messages.
```

## Scheduler

The scheduler daemon runs in the background and executes jobs when they're due.

### Start manually

```bash
node ~/.pi/agent/git/github.com/SubZzzzzz/thetis-cron/scheduler.ts
```

### Install as systemd service

```bash
# Copy the service file
cp ~/.pi/agent/git/github.com/SubZzzzzz/thetis-cron/systemd/pi-cron-scheduler.service ~/.config/systemd/user/

# Enable and start
systemctl --user enable pi-cron-scheduler.service
systemctl --user start pi-cron-scheduler.service

# Enable at boot
loginctl enable-linger $USER
```

### Check scheduler status

```bash
systemctl --user status pi-cron-scheduler.service
```

Or via Pi:

```
cron(action="status")
```

## Schedule Formats

### Natural language

- `every 5m` → `*/5 * * * *`
- `every 2h` → `0 */2 * * *`
- `every 1d` → `0 0 */1 * *`
- `every day at 09:00` → `0 9 * * *`
- `every 2h at :30` → `30 */2 * * *`

### Cron expressions

Standard 5-field cron expressions:

```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of the month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of the week (0 - 6) (Sunday to Saturday)
│ │ │ │ │
* * * * *
```

Examples:
- `*/5 * * * *` — every 5 minutes
- `0 */2 * * *` — every 2 hours
- `0 9 * * *` — every day at 09:00
- `0 10 * * 1` — every Monday at 10:00

## Execution Modes

### Script mode (default)

Executes the prompt as a shell command. No LLM cost.

```
cron(action="create", id="backup", schedule="every 1d at 02:00", mode="script", prompt="rsync -av ~/Documents/ ~/backup/")
```

### Agent mode

Runs the prompt through Pi (`pi -p "prompt"`). Uses LLM tokens.

```
cron(action="create", id="daily-news", schedule="every day at 08:00", mode="agent", prompt="Summarize today's top tech news from Hacker News")
```

## Delivery

### ntfy

Send push notifications to your phone via [ntfy.sh](https://ntfy.sh/):

```json
{
  "delivery": {
    "ntfy": "https://ntfy.sh/my-secret-topic"
  }
}
```

### Discord webhook

Send messages to a Discord channel via webhook:

```json
{
  "delivery": {
    "discord_webhook": "https://discord.com/api/webhooks/...",
    "discord_ping": "254309570804056064"
  }
}
```

The `discord_ping` field is optional — if provided, the user will be mentioned.

## Example: Email Monitoring

Here's a complete example for monitoring emails from specific senders:

1. Create a Python script `~/check_emails.py` that checks IMAP for new emails
2. Create the cron job:

```
cron(
  action="create",
  id="email-monitor",
  name="Email Monitor",
  schedule="every 5m",
  mode="script",
  prompt="python3 ~/check_emails.py",
  delivery={
    ntfy: "https://ntfy.sh/my-emails",
    discord_webhook: "https://discord.com/api/webhooks/...",
    discord_ping: "254309570804056064"
  }
)
```

3. Start the scheduler (if not already running)
4. The job will run every 5 minutes and deliver results via ntfy + Discord

## Troubleshooting

### Scheduler not running

Check status:

```
cron(action="status")
```

If scheduler is not running, start it manually or install the systemd service.

### Job not executing

Check the job state:

```bash
cat ~/.pi/agent/cron/<job-id>/state.json
```

Look at `next_run` — if it's in the future, the job isn't due yet.

Force an immediate run:

```
cron(action="run", id="my-job")
```

### Check execution logs

```bash
ls -la ~/.pi/agent/cron/<job-id>/output/
cat ~/.pi/agent/cron/<job-id>/output/2025-01-15T09-00-00.log
```

### Scheduler logs

```bash
tail -f ~/.pi/agent/cron/.scheduler.log
```

## License

MIT — see [LICENSE](./LICENSE)

## Related

- [thetis-tool](https://github.com/SubZzzzzz/thetis-tool) — web scraping, search, speech-to-text
- [thetis-gateway](https://github.com/SubZzzzzz/thetis-gateway) — Discord & WhatsApp gateway
- [thetis-memory](https://github.com/SubZzzzzz/thetis-memory) — structured knowledge vault
