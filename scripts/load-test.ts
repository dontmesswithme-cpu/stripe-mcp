import { initializeAllDatabases, getAuditDb } from "../src/utils/db.js";
import { getDbWorker, shutdownDbWorker, runDbOp } from "../src/worker/db/db.client.js";
import { createExecution } from "../src/execution/store.worker.js";
import { performance } from "node:perf_hooks";

async function main() {
  console.log("Starting Load Test...");
  
  // Connect to worker DB
  await runDbOp("initializeAllDatabases");
  
  const worker = getDbWorker();
  let completed = 0;
  const start = performance.now();
  
  const promises = [];
  
  for (let i = 0; i < 1000; i++) {
    promises.push(
      new Promise(async (resolve) => {
        if (i % 2 === 0) {
          await runDbOp("queryAuditLog", {});
        } else {
          await runDbOp(
            "writeAuditEntry",
            {
              capability: { tool: "test_tool", operation: "create" },
              customerId: "cus_test",
              amount: 100,
              currency: "usd"
            },
            "success",
            0,
            { test: i }
          );
        }
        completed++;
        resolve(true);
      })
    );
  }
  
  await Promise.all(promises);
  const duration = performance.now() - start;
  
  console.log(`Successfully completed ${completed} concurrent DB operations in ${Math.round(duration)}ms.`);
  
  await shutdownDbWorker();
  
  if (completed === 1000) {
    console.log("Load Test PASSED.");
  } else {
    console.error("Load Test FAILED.");
    process.exit(1);
  }
}

main().catch(console.error);
