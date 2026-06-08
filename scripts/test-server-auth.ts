import { spawn } from "node:child_process";
import { request } from "node:http";

console.log("Starting server...");
const child = spawn("npx", ["tsx", "./scripts/test-server-start.ts"], {
  env: { ...process.env, APPROVAL_API_KEY: "supersecret" },
  stdio: "inherit",
  shell: true
});

setTimeout(() => {
  console.log("Sending authorized request...");
  const req = request({
    hostname: "127.0.0.1",
    port: 3001,
    path: "/approvals/12345678-1234-1234-1234-123456789012",
    method: "GET",
    headers: {
      Authorization: "Bearer supersecret"
    }
  }, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      console.log("Status Code:", res.statusCode);
      console.log("Response:", data);
      
      console.log("Sending unauthorized request...");
      const req2 = request({
        hostname: "127.0.0.1",
        port: 3001,
        path: "/approvals/12345678-1234-1234-1234-123456789012",
        method: "GET",
        headers: {
          Authorization: "Bearer wrongkey"
        }
      }, (res2) => {
        child.kill();
        if (res.statusCode === 404 && res2.statusCode === 401) {
          console.log("SUCCESS: Authentication working correctly.");
          process.exit(0);
        } else {
          console.log("FAIL: Authentication failed. Expected 404 for valid key, 401 for invalid.");
          process.exit(1);
        }
      });
      req2.end();
    });
  });

  req.on("error", (err) => {
    console.error("Request failed:", err);
    child.kill();
    process.exit(1);
  });

  req.end();
}, 2000);
