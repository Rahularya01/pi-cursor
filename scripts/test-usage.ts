import assert from "node:assert/strict";
import {
  formatCursorUsage,
  getCursorUsageSummary,
  parseConnectPeriodUsage,
  parseCursorUsageSummary,
} from "../src/usage.ts";

const summary = parseCursorUsageSummary({
  billingCycleStart: "2026-04-02T14:11:55.000Z",
  billingCycleEnd: "2026-05-02T14:11:55.000Z",
  membershipType: "Pro",
  limitType: "individual",
  individualUsage: {
    plan: {
      enabled: true,
      used: 40,
      limit: 100,
      remaining: 60,
      totalPercentUsed: 40,
      autoPercentUsed: 35,
      apiPercentUsed: 45,
    },
    onDemand: { enabled: true, used: 1234 },
  },
});

const output = formatCursorUsage(summary);
assert.match(output, /Usage • Pro/);
assert.match(output, /Category\s+Current\s+Usage/);
assert.match(output, /Included\s+40% used/);
assert.match(output, /Auto\s+35% used/);
assert.match(output, /API\s+45% used/);
assert.match(output, /View in dashboard: cursor\.com\/dashboard\?tab=usage/);
assert.throws(() => parseCursorUsageSummary(null), /invalid response/);

const connectSummary = parseConnectPeriodUsage({
  billingCycleStart: "1783190438000",
  billingCycleEnd: "1785868838000",
  planUsage: {
    includedSpend: 2000,
    limit: 2000,
    totalPercentUsed: 12.72,
    autoPercentUsed: 12.0,
    apiPercentUsed: 14.0,
  },
  spendLimitUsage: { limitType: "user" },
});
const connectOutput = formatCursorUsage(connectSummary);
assert.match(connectOutput, /Usage • Pro/);
assert.match(connectOutput, /Included\s+13% used/);
assert.match(connectOutput, /Auto\s+12% used/);
assert.match(connectOutput, /API\s+14% used/);

await assert.rejects(
  () => getCursorUsageSummary(undefined, ""),
  /Not logged in to Cursor\. Please log in with Cursor CLI/,
);

console.log("test-usage: ok");
