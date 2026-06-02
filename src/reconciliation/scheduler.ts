/**
 * @module reconciliation/scheduler
 *
 * Single-flight reconciliation loop (no overlapping cycles).
 */

import { config } from "../config.js";
import { runReconciliationCycle } from "./worker.js";

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
    await runReconciliationCycle();
  } catch (error) {
    console.error("[RECONCILIATION] Cycle failed", error);
  } finally {
    cycleInFlight = false;
    scheduleNext(config.reconciliationIntervalMs);
  }
}

export function startReconciliationLoop(): void {
  stopped = false;
  void runCycle();
}

export function stopReconciliationLoop(): void {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
