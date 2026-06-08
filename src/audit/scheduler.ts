/**
 * @module audit/scheduler
 *
 * Single-flight audit log pruning loop.
 */

import { config } from "../config.js";
import { pruneAuditLog } from "./prune.js";
import { logger } from "../utils/logger.js";

let stopped = false;
let cycleInFlight = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleNext(delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runCycle();
  }, delayMs);
  timer.unref();
}

async function runCycle(): Promise<void> {
  if (stopped || cycleInFlight) {
    return;
  }

  cycleInFlight = true;
  try {
    // Run asynchronously
    await pruneAuditLog();
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "[AUDIT PRUNE] Cycle failed"
    );
  } finally {
    cycleInFlight = false;
    scheduleNext(config.auditPruneIntervalMs);
  }
}

export function startAuditPruneLoop(): void {
  stopped = false;
  // Trigger immediately on startup, then schedule
  void runCycle();
}

export function stopAuditPruneLoop(): void {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
