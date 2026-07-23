import { describe, expect, it } from "vitest";
import {
  formatCursorUsage,
  parseConnectPeriodUsage,
  parseCursorUsageSummary,
} from "../src/usage.js";

describe("usage formatting", () => {
  it("formats plan usage bars", () => {
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
    expect(output).toMatch(/Usage • Pro/);
    expect(output).toMatch(/Included\s+40% used/);
    expect(output).toMatch(/cursor\.com\/dashboard\?tab=usage/);
  });

  it("parses connect period usage", () => {
    const connectSummary = parseConnectPeriodUsage({
      billingCycleStart: "1783190438000",
      billingCycleEnd: "1785868838000",
      planUsage: {
        totalPercentUsed: 10,
        autoPercentUsed: 5,
        apiPercentUsed: 15,
      },
      membershipType: "Pro",
    });
    expect(connectSummary.membershipType).toBe("Pro");
  });
});
