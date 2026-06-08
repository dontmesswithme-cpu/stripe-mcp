import { computeRequestHash } from "../src/approval/store.worker.js";

const ctx1: any = {
  capability: { tool: "test", operation: "test" },
  params: { items: ["A", "B"], idempotency_key: "test" }
};
const ctx2: any = {
  capability: { tool: "test", operation: "test" },
  params: { items: ["B", "A"], idempotency_key: "test" }
};

const hash1 = computeRequestHash(ctx1);
const hash2 = computeRequestHash(ctx2);

console.log("hash1:", hash1);
console.log("hash2:", hash2);

if (hash1 !== hash2) {
  console.log("SUCCESS: Hashes are different.");
  process.exit(0);
} else {
  console.log("FAIL: Hashes are identical.");
  process.exit(1);
}
