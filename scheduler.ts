#!/usr/bin/env node
/**
 * Thetis Cron Scheduler — Background Daemon
 *
 * Runs as a standalone process. Ticks every 60 seconds, checks for due jobs,
 * executes them, and delivers results via ntfy/Discord.
 *
 * Usage:
 *   node scheduler.ts
 *   # or via systemd service
 *
 * Logs to ~/.pi/agent/cron/.scheduler.log
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { Cron } from "croner";

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

const CRON_DIR = path.join(homedir(), ".pi", "agent", "cron");
const PID_FILE = path.join(CRON_DIR, ".scheduler.pid");
const LOG_FILE = path.join(CRON_DIR, ".scheduler.log");
const TICK_INTERVAL_MS = 60_000; // 1 minute

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface JobConfig {
  id: string;
  name: string;
  schedule?: string;              // Cron expression (optional if interval_minutes is set)
  interval_minutes?: number;      // Alternative to cron: run every X minutes
  schedule_human: string;
  always_notify?: boolean;        // Send notification even when no results
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
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    // Ignore log write errors
  }
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
      log(`⚠️  Failed to parse job: ${entry.name}`);
    }
  }
  return jobs;
}

function readPrompt(id: string): string {
  const promptPath = path.join(CRON_DIR, id, "prompt.md");
  if (!fs.existsSync(promptPath)) return "";
  return fs.readFileSync(promptPath, "utf8");
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

function getNextRun(cronExpr: string): string | null {
  try {
    const job = new Cron(cronExpr);
    const next = job.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

function getNextRunFromInterval(intervalMinutes: number, lastRun: string | null): string {
  const now = new Date();
  
  // Align to interval boundaries from midnight (e.g., every 90min = 00:00, 01:30, 03:00, 04:30...)
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const msSinceMidnight = now.getTime() - midnight.getTime();
  const periodsSinceMidnight = Math.floor(msSinceMidnight / (intervalMinutes * 60 * 1000));
  const nextPeriodMinutes = (periodsSinceMidnight + 1) * intervalMinutes;
  const nextRun = new Date(midnight.getTime() + nextPeriodMinutes * 60 * 1000);
  
  return nextRun.toISOString();
}

function isDue(job: JobConfig, state: JobState): boolean {
  if (!state.next_run) return false;
  const nextRun = new Date(state.next_run);
  const now = new Date();
  return nextRun <= now;
}

/* ------------------------------------------------------------------ */
/*  Execution                                                          */
/* ------------------------------------------------------------------ */

async function executeJob(
  job: JobConfig
): Promise<{ success: boolean; output: string; error?: string }> {
  const prompt = readPrompt(job.id);
  if (!prompt.trim()) {
    return { success: false, output: "", error: "Empty prompt" };
  }

  try {
    let output: string;

    if (job.mode === "script") {
      // Write prompt to a temp file in the job dir so BASH_SOURCE works
      const jobDir = path.join(CRON_DIR, job.id);
      const tmpScript = path.join(jobDir, ".run.sh");
      fs.writeFileSync(tmpScript, prompt, "utf8");
      fs.chmodSync(tmpScript, 0o755);
      try {
        output = execSync(`bash ${JSON.stringify(tmpScript)}`, {
          encoding: "utf8",
          timeout: 900_000, // 15 min timeout
          maxBuffer: 10 * 1024 * 1024, // 10MB
          cwd: jobDir,
        });
      } finally {
        try { fs.unlinkSync(tmpScript); } catch {}
      }
    } else {
      // Execute as Pi agent (pi -p "prompt")
      output = execSync(`pi -p ${JSON.stringify(prompt)}`, {
        encoding: "utf8",
        timeout: 900_000, // 15 min timeout
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

/* ------------------------------------------------------------------ */
/*  Delivery                                                           */
/* ------------------------------------------------------------------ */

async function deliverResult(
  job: JobConfig,
  output: string,
  success: boolean
): Promise<void> {
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
      log(`📤 ntfy delivered for ${job.id}`);
    } catch (err: any) {
      log(`⚠️  ntfy delivery failed for ${job.id}: ${err.message}`);
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
          allowed_mentions: delivery.discord_ping
            ? { users: [delivery.discord_ping] }
            : undefined,
        }),
      });
      log(`📤 Discord delivered for ${job.id}`);
    } catch (err: any) {
      log(`⚠️  Discord delivery failed for ${job.id}: ${err.message}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main tick                                                          */
/* ------------------------------------------------------------------ */

async function tick(): Promise<void> {
  const jobs = listJobs();
  const dueJobs = jobs.filter((job) => {
    if (!job.enabled) return false;
    const state = readState(job.id);
    return isDue(job, state);
  });

  if (dueJobs.length === 0) return;

  log(`⏰ ${dueJobs.length} job(s) due: ${dueJobs.map((j) => j.id).join(", ")}`);

  for (const job of dueJobs) {
    log(`🚀 Executing job: ${job.id}`);

    const result = await executeJob(job);
    const now = new Date().toISOString();

    // Update state
    const state = readState(job.id);
    state.last_run = now;
    state.run_count++;
    state.last_status = result.success ? "success" : "error";
    state.last_error = result.error || null;
    
    // Calculate next run based on interval_minutes or schedule
    if (job.interval_minutes) {
      state.next_run = getNextRunFromInterval(job.interval_minutes, now);
    } else if (job.schedule) {
      state.next_run = getNextRun(job.schedule);
    }
    
    writeState(job.id, state);

    // Save output log
    const outputDir = path.join(CRON_DIR, job.id, "output");
    ensureDir(outputDir);
    const logFile = path.join(outputDir, `${now.replace(/[:.]/g, "-")}.log`);
    fs.writeFileSync(
      logFile,
      result.output + (result.error ? `\n\nERROR: ${result.error}` : ""),
      "utf8"
    );

    // Deliver result
    await deliverResult(job, result.output, result.success);

    if (result.success) {
      log(`✅ Job ${job.id} completed successfully`);
    } else {
      log(`❌ Job ${job.id} failed: ${result.error}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Startup                                                            */
/* ------------------------------------------------------------------ */

function checkPidFile(): boolean {
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
      // Check if process is alive
      process.kill(pid, 0);
      log(`❌ Scheduler already running (PID ${pid})`);
      return false;
    } catch {
      // Process not running, clean up stale PID file
      try {
        fs.unlinkSync(PID_FILE);
      } catch {
        // Ignore
      }
    }
  }
  return true;
}

function writePidFile(): void {
  ensureDir(CRON_DIR);
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
}

function cleanup(): void {
  log("🛑 Scheduler shutting down");
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Initialization                                                     */
/* ------------------------------------------------------------------ */

function initializeJobs(): void {
  const jobs = listJobs();
  const now = new Date();
  
  for (const job of jobs) {
    const state = readState(job.id);
    
    // Recalculate next_run if null or in the past
    if (!state.next_run || new Date(state.next_run) <= now) {
      if (job.interval_minutes) {
        state.next_run = getNextRunFromInterval(job.interval_minutes, state.last_run);
      } else if (job.schedule) {
        state.next_run = getNextRun(job.schedule);
      }
      writeState(job.id, state);
      log(`🔄 Job ${job.id}: next_run initialized to ${state.next_run}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (!checkPidFile()) {
    process.exit(1);
  }

  writePidFile();

  // Signal handlers
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  log(`🟢 Scheduler started (PID ${process.pid})`);
  log(`📂 Jobs directory: ${CRON_DIR}`);
  log(`⏱️  Tick interval: ${TICK_INTERVAL_MS / 1000}s`);

  // Initialize jobs on startup
  initializeJobs();

  // Initial tick
  await tick();

  // Schedule recurring ticks
  setInterval(async () => {
    try {
      await tick();
    } catch (err: any) {
      log(`❌ Tick failed: ${err.message}`);
    }
  }, TICK_INTERVAL_MS);
}

main().catch((err) => {
  log(`❌ Fatal error: ${err.message}`);
  cleanup();
});
