import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { runDbOp, shutdownDbWorker, getDbWorker } from "../src/worker/db/db.client.js";

describe("worker/db/db.client", () => {
  beforeAll(async () => {
    await runDbOp("initializeAllDatabases");
  });

  afterAll(async () => {
    await shutdownDbWorker();
  });

  it("handles worker throwing an error gracefully", async () => {
    await expect(runDbOp("nonExistentMethod")).rejects.toThrow("Unknown DB worker method: nonExistentMethod");
  });

  it("rejects pending requests when worker crashes", async () => {
    const promise = runDbOp("testQuery", "SELECT 1");
    getDbWorker().emit("error", new Error("Simulated Crash"));
    
    await expect(promise).rejects.toThrow("Worker crashed");
  });

  it("triggers timeout if operation exceeds 15 seconds", async () => {
    vi.useFakeTimers();
    const promise = runDbOp("testQuery", "SELECT 1"); // Assuming it hangs or we just advance time
    
    // We advance time to force a timeout
    vi.advanceTimersByTime(16000);
    
    await expect(promise).rejects.toThrow(/DB operation timeout/);
    vi.useRealTimers();
  });
});
