import { mkdirSync } from "node:fs";

process.env.STRIPE_MCP_DATA_DIR ??= "./data-test";
process.env.APPROVAL_API_KEY ??= "test_key";
process.env.STRIPE_API_KEY ??= "dummy_stripe_key_for_testing";
process.env.STRIPE_READ_ONLY ??= "false";
process.env.STRIPE_DRY_RUN ??= "false";

mkdirSync(process.env.STRIPE_MCP_DATA_DIR, { recursive: true });
