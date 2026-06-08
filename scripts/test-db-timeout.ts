import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";

async function testTimeout() {
  console.log("Sending testHang request, expecting timeout in 15 seconds...");
  const start = Date.now();
  try {
    await runDbOp("testHang");
    console.error("FAIL: Did not timeout!");
    process.exit(1);
  } catch (err: any) {
    const elapsed = Date.now() - start;
    if (err.message.includes("DB operation timeout")) {
      console.log(`PASS: Timeout occurred after ${elapsed}ms:`, err.message);
    } else {
      console.error(`FAIL: Unexpected error:`, err);
      process.exit(1);
    }
  } finally {
    await shutdownDbWorker();
  }
}

testTimeout();
