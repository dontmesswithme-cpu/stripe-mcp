import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";
import { getExecution } from "../src/execution/store.worker.js";
import { getApprovalsDb } from "../src/utils/db.js";

async function main() {
  console.log("Starting Timeout Simulation Test...");
  
  let timedOut = false;
  try {
    await runDbOp("testTimeoutExecution");
  } catch (error: any) {
    if (error.message.includes("timeout")) {
      console.log("Client successfully threw a timeout error.");
      timedOut = true;
    } else {
      console.error("Unexpected error:", error);
    }
  }

  if (!timedOut) {
    console.error("FAIL: Did not time out as expected.");
    process.exit(1);
  }

  // Allow the worker to finish its sleep and process the operation.
  // The worker sleeps for 16s, we waited 15s. So wait 2s more.
  console.log("Waiting for worker to finish the delayed execution...");
  await new Promise(r => setTimeout(r, 2000));

  await shutdownDbWorker();

  console.log("Checking database state...");
  const db = getApprovalsDb();
  const row = db.prepare("SELECT * FROM executions WHERE idempotency_key = 'testidemp'").get();

  if (row) {
    console.error("FAIL: Database state is NOT pristine. Phantom write occurred:", row);
    process.exit(1);
  } else {
    console.log("SUCCESS: Database state remains pristine (no records inserted).");
    process.exit(0);
  }
}

main().catch(e => {
  console.error("Fatal error in test:", e);
  process.exit(1);
});
