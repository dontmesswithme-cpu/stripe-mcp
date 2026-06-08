import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";

async function run() {
  try {
    await runDbOp("testQuery", "SELECT * FROM approvals");
    console.error("FAIL: Did not throw an error");
    process.exit(1);
  } catch (error: any) {
    if (error.message.includes("Unknown DB worker method")) {
      console.log("PASS: Caught explicit Unknown DB worker method error");
    } else {
      console.error("FAIL: Caught unexpected error", error);
      process.exit(1);
    }
  } finally {
    await shutdownDbWorker();
  }
}

run();
