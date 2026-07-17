/**
 * Thetis Cron Extension — Scheduled Task Runner for Pi
 *
 * Manage cron jobs that run on a schedule with delivery to Discord, ntfy, etc.
 * Jobs are stored in ~/.pi/agent/cron/<job-id>/ with separate files for config and prompt.
 *
 * Tool: cron (create, list, pause, resume, remove, edit, run, status)
 * Command: /cron (same actions via slash command)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Cron } from "croner";

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

const CRON_DIR = path.join(homedir(), ".pi", "agent", "cron");
const SCHEDULER_PID_FILE = path.join(CRON_DIR, ".scheduler.pid");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface JobConfig {
  id: string;
  name: string;
  schedule: string;
  schedule_human: string;
  mode: "agent" | "script";
  enabled: boolean;
  delivery: {
    ntfy?: string;
    discord_webhook?: string;
    discord_ping?: string;
  };
  created_at: string;
  updated_at: string;
}

interface JobState {
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  last_status: "success" | "error" | null;
  last_error: string | null;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listJobs(): JobConfig[] {
  ensureDir(CRON_DIR);
  const jobs: JobConfig[] = [];
  for (const entry of fs.readdirSync(CRON_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const jobPath = path.join(CRON_DIR, entry.name, "job.json");
    if (!fs.existsSync(jobPath)) continue;
    try {
      const job = JSON.parse(fs.readFileSync(jobPath, "utf8")) as JobConfig;
      jobs.push(job);
    } catch {
      // Skip invalid jobs
    }
  }
  return jobs.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function readJob(id: string): JobConfig | null {
  const jobPath = path.join(CRON_DIR, id, "job.json");
  if (!fs.existsSync(jobPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jobPath, "utf8")) as JobConfig;
  } catch {
    return null;
  }
}

function writeJob(job: JobConfig): void {
  const jobDir = path.join(CRON_DIR, job.id);
  ensureDir(jobDir);
  fs.writeFileSync(
    path.join(jobDir, "job.json"),
    JSON.stringify(job, null, 2) + "\n",
    "utf8"
  );
}

function readPrompt(id: string): string {
  const promptPath = path.join(CRON_DIR, id, "prompt.md");
  if (!fs.existsSync(promptPath)) return "";
  return fs.readFileSync(promptPath, "utf8");
}

function writePrompt(id: string, prompt: string): void {
  const jobDir = path.join(CRON_DIR, id);
  ensureDir(jobDir);
  fs.writeFileSync(path.join(jobDir, "prompt.md"), prompt, "utf8");
}

function readState(id: string): JobState {
  const statePath = path.join(CRON_DIR, id, "state.json");
  if (!fs.existsSync(statePath)) {
    return {
      last_run: null,
      next_run: null,
      run_count: 0,
      last_status: null,
      last_error: null,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as JobState;
  } catch {
    return {
      last_run: null,
      next_run: null,
      run_count: 0,
      last_status: null,
      last_error: null,
    };
  }
}

function writeState(id: string, state: JobState): void {
  const jobDir = path.join(CRON_DIR, id);
  ensureDir(jobDir);
  fs.writeFileSync(
    path.join(jobDir, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf8"
  );
}

function parseSchedule(schedule: string): { cron: string; human: string } {
  const s = schedule.trim().toLowerCase();

  // Natural language patterns
  const everyMatch = s.match(/^every\s+(\d+)(m|h|d)$/);
  if (everyMatch) {
    const value = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2];
    if (unit === "m") return { cron: `*/${value} * * * *`, human: `every ${value}m` };
    if (unit === "h") return { cron: `0 */${value} * * *`, human: `every ${value}h` };
    if (unit === "d") return { cron: `0 0 */${value} * *`, human: `every ${value}d` };
  }

  const everyAtMatch = s.match(/^every\s+(\d+)(m|h|d)\s+at\s+:(\d{2})$/);
  if (everyAtMatch) {
    const value = parseInt(everyAtMatch[1], 10);
    const unit = everyAtMatch[2];
    const minute = everyAtMatch[3];
    if (unit === "h") return { cron: `${minute} */${value} * * *`, human: `every ${value}h at :${minute}` };
  }

  const dailyAtMatch = s.match(/^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/);
  if (dailyAtMatch) {
    const hour = dailyAtMatch[1];
    const minute = dailyAtMatch[2];
    return { cron: `${minute} ${hour} * * *`, human: `every day at ${hour}:${minute}` };
  }

  // Assume it's already a cron expression
  return { cron: schedule.trim(), human: schedule.trim() };
}

function validateCron(cronExpr: string): boolean {
  try {
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}

function getNextRun(cronExpr: string): string | null {
  try {
    const job = new Cron(cronExpr);
    const next = job.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Execution                                                          */
/* ------------------------------------------------------------------ */

async function executeJob(job: JobConfig): Promise<{ success: boolean; output: string; error?: string }> {
  const prompt = readPrompt(job.id);
  if (!prompt.trim()) {
    return { success: false, output: "", error: "Empty prompt" };
  }

  try {
    let output: string;

    if (job.mode === "script") {
      // Execute as shell command
      output = execSync(prompt, {
        encoding: "utf8",
        timeout: 300_000, // 5 min timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
    } else {
      // Execute as Pi agent (pi -p "prompt")
      output = execSync(`pi -p ${JSON.stringify(prompt)}`, {
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    return { success: true, output };
  } catch (err: any) {
    return {
      success: false,
      output: err.stdout || "",
      error: err.message || String(err),
    };
  }
}

async function deliverResult(job: JobConfig, output: string, success: boolean): Promise<void> {
  const { delivery } = job;

  // ntfy
  if (delivery.ntfy) {
    try {
      await fetch(delivery.ntfy, {
        method: "POST",
        headers: {
          Title: success ? `✅ ${job.name}` : `❌ ${job.name}`,
          Priority: success ? "default" : "high",
          Tags: success ? "white_check_mark" : "x",
        },
        body: output.slice(0, 4000),
      });
    } catch {
      // Delivery failure is not fatal
    }
  }

  // Discord webhook
  if (delivery.discord_webhook) {
    try {
      const content = delivery.discord_ping
        ? `<@${delivery.discord_ping}> ${success ? "✅" : "❌"} **${job.name}**\n\n\`\`\`\n${output.slice(0, 1900)}\n\`\`\``
        : `${success ? "✅" : "❌"} **${job.name}**\n\n\`\`\`\n${output.slice(0, 1900)}\n\`\`\``;

      await fetch(delivery.discord_webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          allowed_mentions: delivery.discord_ping ? { users: [delivery.discord_ping] } : undefined,
        }),
      });
    } catch {
      // Delivery failure is not fatal
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Scheduler status                                                   */
/* ------------------------------------------------------------------ */

function isSchedulerRunning(): { running: boolean; pid?: number } {
  if (!fs.existsSync(SCHEDULER_PID_FILE)) return { running: false };
  try {
    const pid = parseInt(fs.readFileSync(SCHEDULER_PID_FILE, "utf8").trim(), 10);
    // Check if process is alive
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process not running, clean up stale PID file
    try {
      fs.unlinkSync(SCHEDULER_PID_FILE);
    } catch {
      // Ignore
    }
    return { running: false };
  }
}

/* ------------------------------------------------------------------ */
/*  Tool: cron                                                         */
/* ------------------------------------------------------------------ */

const CronParams = Type.Object({
  action: StringEnum(
    ["create", "list", "pause", "resume", "remove", "edit", "run", "status"] as const,
    { description: "Action to perform" }
  ),
  id: Type.Optional(
    Type.String({ description: "Job ID (human-readable slug, e.g. 'email-monitor')" })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Schedule: cron expression ('*/5 * * * *') or natural ('every 5m', 'every 2h', 'every day at 09:00')",
    })
  ),
  prompt: Type.Optional(
    Type.String({ description: "Prompt text or shell command to execute" })
  ),
  mode: Type.Optional(
    StringEnum(["agent", "script"] as const, {
      description: "Execution mode: 'agent' = pi -p prompt, 'script' = shell command (default: script)",
    })
  ),
  name: Type.Optional(Type.String({ description: "Human-readable name for the job" })),
  delivery: Type.Optional(
    Type.Object({
      ntfy: Type.Optional(
        Type.String({ description: "ntfy topic URL (e.g. https://ntfy.sh/my-topic)" })
      ),
      discord_webhook: Type.Optional(Type.String({ description: "Discord webhook URL" })),
      discord_ping: Type.Optional(Type.String({ description: "Discord user ID to ping" })),
    })
  ),
});

async function handleCreate(params: typeof CronParams.static): Promise<string> {
  const { id, schedule, prompt, mode, name, delivery } = params;
  if (!id) return "❌ Missing job ID. Use cron(action='create', id='my-job', ...)";
  if (!schedule) return "❌ Missing schedule. Use cron(action='create', schedule='every 5m', ...)";
  if (!prompt) return "❌ Missing prompt. Use cron(action='create', prompt='...', ...)";

  // Check if job already exists
  if (readJob(id)) return `❌ Job "${id}" already exists. Use cron(action='edit', id='${id}', ...) to modify it.`;

  // Parse schedule
  const { cron, human } = parseSchedule(schedule);
  if (!validateCron(cron)) return `❌ Invalid schedule: "${schedule}" (parsed as "${cron}")`;

  // Create job
  const now = new Date().toISOString();
  const job: JobConfig = {
    id,
    name: name || id,
    schedule: cron,
    schedule_human: human,
    mode: mode || "script",
    enabled: true,
    delivery: delivery || {},
    created_at: now,
    updated_at: now,
  };

  writeJob(job);
  writePrompt(id, prompt);

  const state: JobState = {
    last_run: null,
    next_run: getNextRun(cron),
    run_count: 0,
    last_status: null,
    last_error: null,
  };
  writeState(id, state);

  // Ensure output dir exists
  ensureDir(path.join(CRON_DIR, id, "output"));

  const schedulerStatus = isSchedulerRunning();
  const schedulerNote = schedulerStatus.running
    ? "✅ Scheduler is running — job will be picked up automatically."
    : "⚠️ Scheduler is NOT running. Start it with: `node ~/.pi/agent/git/github.com/SubZzzzzz/thetis-cron/scheduler.ts` or install the systemd service.";

  return `✅ Job "${id}" created.\n📅 Schedule: ${human} (${cron})\n🔧 Mode: ${job.mode}\n📍 Path: ~/.pi/agent/cron/${id}/\n\n${schedulerNote}`;
}

async function handleList(): Promise<string> {
  const jobs = listJobs();
  if (jobs.length === 0) return "No cron jobs found. Use cron(action='create', ...) to add one.";

  const schedulerStatus = isSchedulerRunning();
  const header = schedulerStatus.running
    ? `🟢 Scheduler running (PID ${schedulerStatus.pid})\n\n`
    : "🔴 Scheduler NOT running\n\n";

  const lines = jobs.map((job) => {
    const state = readState(job.id);
    const status = job.enabled ? "✅" : "⏸️";
    const lastRun = state.last_run ? new Date(state.last_run).toLocaleString() : "never";
    const nextRun = state.next_run ? new Date(state.next_run).toLocaleString() : "—";
    return `${status} **${job.name}** (\`${job.id}\`)\n   📅 ${job.schedule_human} | 🕐 Next: ${nextRun}\n   Last run: ${lastRun} | Runs: ${state.run_count} | Status: ${state.last_status || "—"}`;
  });

  return header + lines.join("\n\n");
}

async function handlePause(id: string): Promise<string> {
  const job = readJob(id);
  if (!job) return `❌ Job "${id}" not found.`;
  if (!job.enabled) return `⏸️ Job "${id}" is already paused.`;

  job.enabled = false;
  job.updated_at = new Date().toISOString();
  writeJob(job);

  const state = readState(id);
  state.next_run = null;
  writeState(id, state);

  return `⏸️ Job "${id}" paused.`;
}

async function handleResume(id: string): Promise<string> {
  const job = readJob(id);
  if (!job) return `❌ Job "${id}" not found.`;
  if (job.enabled) return `✅ Job "${id}" is already running.`;

  job.enabled = true;
  job.updated_at = new Date().toISOString();
  writeJob(job);

  const state = readState(id);
  state.next_run = getNextRun(job.schedule);
  writeState(id, state);

  return `✅ Job "${id}" resumed. Next run: ${state.next_run ? new Date(state.next_run).toLocaleString() : "—"}`;
}

async function handleRemove(id: string): Promise<string> {
  const job = readJob(id);
  if (!job) return `❌ Job "${id}" not found.`;

  const jobDir = path.join(CRON_DIR, id);
  fs.rmSync(jobDir, { recursive: true, force: true });

  return `🗑️ Job "${id}" removed.`;
}

async function handleEdit(params: typeof CronParams.static): Promise<string> {
  const { id, schedule, prompt, mode, name, delivery } = params;
  if (!id) return "❌ Missing job ID.";

  const job = readJob(id);
  if (!job) return `❌ Job "${id}" not found.`;

  const changes: string[] = [];

  if (schedule) {
    const { cron, human } = parseSchedule(schedule);
    if (!validateCron(cron)) return `❌ Invalid schedule: "${schedule}" (parsed as "${cron}")`;
    job.schedule = cron;
    job.schedule_human = human;
    changes.push(`schedule → ${human} (${cron})`);
  }

  if (mode) {
    job.mode = mode;
    changes.push(`mode → ${mode}`);
  }

  if (name) {
    job.name = name;
    changes.push(`name → ${name}`);
  }

  if (delivery) {
    job.delivery = { ...job.delivery, ...delivery };
    changes.push(`delivery updated`);
  }

  if (prompt) {
    writePrompt(id, prompt);
    changes.push(`prompt updated`);
  }

  if (changes.length === 0) return `No changes specified for job "${id}".`;

  job.updated_at = new Date().toISOString();
  writeJob(job);

  // Recalculate next_run if schedule changed
  if (schedule && job.enabled) {
    const state = readState(id);
    state.next_run = getNextRun(job.schedule);
    writeState(id, state);
  }

  return `✏️ Job "${id}" updated: ${changes.join(", ")}`;
}

async function handleRun(id: string): Promise<string> {
  const job = readJob(id);
  if (!job) return `❌ Job "${id}" not found.`;

  const result = await executeJob(job);
  const now = new Date().toISOString();

  // Update state
  const state = readState(id);
  state.last_run = now;
  state.run_count++;
  state.last_status = result.success ? "success" : "error";
  state.last_error = result.error || null;
  writeState(id, state);

  // Save output log
  const outputDir = path.join(CRON_DIR, id, "output");
  ensureDir(outputDir);
  const logFile = path.join(outputDir, `${now.replace(/[:.]/g, "-")}.log`);
  fs.writeFileSync(logFile, result.output + (result.error ? `\n\nERROR: ${result.error}` : ""), "utf8");

  // Deliver result
  await deliverResult(job, result.output, result.success);

  if (result.success) {
    return `✅ Job "${id}" executed successfully.\nOutput:\n\`\`\`\n${result.output.slice(0, 1000)}\n\`\`\``;
  } else {
    return `❌ Job "${id}" failed: ${result.error}\nOutput:\n\`\`\`\n${result.output.slice(0, 1000)}\n\`\`\``;
  }
}

async function handleStatus(): Promise<string> {
  const schedulerStatus = isSchedulerRunning();
  const jobs = listJobs();
  const enabledJobs = jobs.filter((j) => j.enabled);

  const lines = [
    `**Scheduler:** ${schedulerStatus.running ? `🟢 Running (PID ${schedulerStatus.pid})` : "🔴 Not running"}`,
    `**Total jobs:** ${jobs.length}`,
    `**Enabled jobs:** ${enabledJobs.length}`,
    "",
    "---",
    "",
  ];

  if (jobs.length === 0) {
    lines.push("_No cron jobs configured._\n");
    lines.push("Use the `cron` tool to create your first job.");
  } else {
    lines.push("**📋 Cron Jobs:**\n");
    
    for (const job of jobs) {
      const state = readState(job.id);
      const statusIcon = job.enabled ? "🟢" : "🔴";
      const statusText = job.enabled ? "ACTIVE" : "PAUSED";
      const lastStatus = state.last_status === "success" ? "✅" : state.last_status === "error" ? "❌" : "—";
      const lastRun = state.last_run ? new Date(state.last_run).toLocaleString() : "never";
      const nextRun = state.next_run && job.enabled ? new Date(state.next_run).toLocaleString() : "—";
      
      lines.push(`**${statusIcon} ${job.name}** \`${job.id}\` — **${statusText}**`);
      lines.push(`   📅 Schedule: ${job.schedule_human}`);
      lines.push(`   🕐 Last run: ${lastRun} (${lastStatus})`);
      lines.push(`   ⏭️  Next run: ${nextRun}`);
      lines.push(`   🔢 Total runs: ${state.run_count}`);
      if (state.last_status === "error" && state.last_error) {
        lines.push(`   ⚠️  Last error: ${state.last_error.slice(0, 100)}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("_Commands: `/cron list`, `/cron status`, `cron(action='pause'|'resume'|'run', id='...')`_");

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Extension entry point                                              */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  // Register the cron tool
  pi.registerTool({
    name: "cron",
    label: "Cron Job Manager",
    description:
      "Manage scheduled tasks (cron jobs) with delivery to Discord, ntfy, etc. Jobs are stored in ~/.pi/agent/cron/",
    promptSnippet: "Manage scheduled cron jobs with create/list/pause/resume/remove/edit/run/status actions",
    promptGuidelines: [
      "Use the cron tool when the user wants to schedule recurring tasks, automate workflows, or set up monitoring.",
      "Job IDs should be human-readable slugs (e.g. 'email-monitor', 'daily-digest').",
      "Schedules support cron expressions ('*/5 * * * *') or natural language ('every 5m', 'every 2h', 'every day at 09:00').",
      "Mode 'script' executes the prompt as a shell command. Mode 'agent' runs it through Pi (pi -p).",
    ],
    parameters: CronParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let result: string;

      switch (params.action) {
        case "create":
          result = await handleCreate(params);
          break;
        case "list":
          result = await handleList();
          break;
        case "pause":
          if (!params.id) {
            result = "❌ Missing job ID. Use cron(action='pause', id='my-job')";
          } else {
            result = await handlePause(params.id);
          }
          break;
        case "resume":
          if (!params.id) {
            result = "❌ Missing job ID. Use cron(action='resume', id='my-job')";
          } else {
            result = await handleResume(params.id);
          }
          break;
        case "remove":
          if (!params.id) {
            result = "❌ Missing job ID. Use cron(action='remove', id='my-job')";
          } else {
            result = await handleRemove(params.id);
          }
          break;
        case "edit":
          result = await handleEdit(params);
          break;
        case "run":
          if (!params.id) {
            result = "❌ Missing job ID. Use cron(action='run', id='my-job')";
          } else {
            result = await handleRun(params.id);
          }
          break;
        case "status":
          result = await handleStatus();
          break;
        default:
          result = `❌ Unknown action: ${params.action}`;
      }

      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });

  // Register /cron command
  pi.registerCommand("cron", {
    description: "Manage cron jobs (list, status, run, etc.)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "list";
      const jobId = parts[1];

      let result: string;

      switch (subcommand) {
        case "list":
        case "ls":
          result = await handleList();
          break;
        case "status":
          result = await handleStatus();
          break;
        case "run":
          if (!jobId) {
            result = "❌ Missing job ID. Usage: /cron run <job-id>";
          } else {
            result = await handleRun(jobId);
          }
          break;
        case "pause":
          if (!jobId) {
            result = "❌ Missing job ID. Usage: /cron pause <job-id>";
          } else {
            result = await handlePause(jobId);
          }
          break;
        case "resume":
          if (!jobId) {
            result = "❌ Missing job ID. Usage: /cron resume <job-id>";
          } else {
            result = await handleResume(jobId);
          }
          break;
        default:
          result = `Usage: /cron [list|status|run|pause|resume] [job-id]\n\nExamples:\n  /cron list\n  /cron status\n  /cron run email-monitor\n  /cron pause email-monitor\n\nUse the \`cron\` tool for full job management (create, edit, remove, etc.).`;
      }

      ctx.ui.notify(result, "info");
    },
  });
}
