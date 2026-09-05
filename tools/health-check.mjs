#!/usr/bin/env node
import { runSourceHealthCheck } from "./health-check-core.mjs";

const result = await runSourceHealthCheck({ rootDir: process.cwd() });

console.log("RIDELIST source health check");
for (const line of result.summary) console.log(`- ${line}`);

if (result.warnings.length) {
  console.log("\nWarnings:");
  for (const warning of result.warnings) console.log(`- ${warning}`);
}

if (result.failures.length) {
  console.error("\nFailures:");
  for (const failure of result.failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\nSource health OK.");
}
