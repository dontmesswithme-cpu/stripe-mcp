import { getAuditDb, initializeAllDatabases } from "../src/utils/db.js";
import { pruneAuditLog } from "../src/audit/prune.worker.js";
import { shutdownDbWorker } from "../src/worker/db/db.client.js";
import { statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";

// Initialize databases to ensure tables exist
initializeAllDatabases();

const db = getAuditDb();

// 1. Inject old records
const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();

console.log("Injecting records with timestamp:", oldDate);

for (let i = 0; i < 50; i++) {
  db.prepare(`
    INSERT INTO audit_log 
    (timestamp, tool_name, customer_id, operation_type, amount, currency, outcome, risk_score, metadata) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    oldDate,
    "test_tool",
    "cus_test" + i,
    "create",
    1000,
    "usd",
    "success",
    0,
    '{"test":true}'
  );
}

const beforeCount = db.prepare("SELECT count(*) as c FROM audit_log").get() as any;
const beforeSize = statSync(join(config.dataDir, "audit.db")).size;
console.log(`Before prune: ${beforeCount.c} records, ${beforeSize} bytes`);

// 2. Run prune
console.log("Running pruneAuditLog()...");
pruneAuditLog();

const afterCount = db.prepare("SELECT count(*) as c FROM audit_log").get() as any;
const afterSize = statSync(join(config.dataDir, "audit.db")).size;
console.log(`After prune: ${afterCount.c} records, ${afterSize} bytes`);

const archiveSize = statSync(join(config.dataDir, "audit_archive.csv")).size;
console.log(`Archive file size: ${archiveSize} bytes`);

await shutdownDbWorker();
