import http from "node:http";
import crypto from "node:crypto";

// We set env vars programmatically before starting the server so config reads them
// NOTE: must be set before dynamically importing the server (see runTest),
// because ESM static imports are hoisted and config.ts is evaluated at import time.
process.env.APPROVAL_PORT = "3002";
process.env.APPROVAL_API_KEY = "test-key";

// Helper to make requests
function makeRequest(path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 3002,
        path,
        method: "POST",
        headers: {
          Authorization: "Bearer test-key"
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 0, body: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function runTest() {
  // Dynamic import AFTER env vars are set: static imports are hoisted in ESM,
  // which would evaluate src/config.ts before the env vars above take effect
  // (leaving approvalApiHash empty and the server disabled). Awaiting the
  // import here guarantees config sees APPROVAL_PORT/APPROVAL_API_KEY.
  const { startApprovalServer, stopApprovalServer } = await import("../src/approval/server.js");

  const server = startApprovalServer();
  if (!server) {
    console.error("FAIL: Server failed to start");
    process.exit(1);
  }

  // Generate a valid UUID token format
  const token = crypto.randomUUID();

  const requests = [
    `/approvals/${token}/approve?bypass=true`,
    `/approvals/${token}/reject?foo=bar`
  ];

  let passed = true;

  for (const reqPath of requests) {
    const response = await makeRequest(reqPath);
    console.log(`Request to ${reqPath} returned status ${response.statusCode}`);
    
    // As per the test definition, if the server correctly recognizes the action,
    // it will return 404 (Token not found) since the token doesn't exist in DB, 
    // but crucially it should NOT return 405 Method Not Allowed.
    if (response.statusCode === 405) {
      console.error(`FAIL: Server returned 405 Method Not Allowed for ${reqPath}`);
      passed = false;
    } else {
      console.log(`PASS: Route matched correctly for ${reqPath}`);
    }
  }

  await stopApprovalServer();

  if (!passed) {
    process.exit(1);
  } else {
    console.log("All Routing Fuzz Tests PASSED.");
    process.exit(0);
  }
}

runTest().catch(err => {
  console.error("Test failed with exception:", err);
  process.exit(1);
});
