import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";

async function testCrash() {
  console.log("Starting crash resilience test...");
  
  // Warm up worker
  await runDbOp("countRecentOperations");
  
  // Start a request that will crash the worker
  const reqPromise = runDbOp("testCrashWorker");
  
  try {
    await reqPromise;
    console.error("FAIL: Pending request succeeded when it should have failed due to crash!");
    process.exit(1);
  } catch (err: any) {
    if (err.message.includes("Worker crashed")) {
      console.log("PASS: Caught 'Worker crashed' error for pending request.");
    } else {
      console.error("FAIL: Caught unexpected error:", err);
      process.exit(1);
    }
  }

  console.log("Attempting a subsequent request to verify respawn...");
  try {
    const result = await runDbOp("countRecentOperations");
    console.log("PASS: Subsequent request succeeded. Respawn works. Result:", result);
  } catch (err) {
    console.error("FAIL: Subsequent request failed:", err);
    process.exit(1);
  }

  await shutdownDbWorker();
  console.log("All tests passed!");
}

testCrash().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
