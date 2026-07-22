import { cursorEnv, isRecord } from "./utils/util.js";

export interface CursorUsageSummary {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType?: string;
  limitType?: string;
  isUnlimited?: boolean;
  individualUsage?: {
    plan?: UsageBucket;
    onDemand?: UsageBucket;
  };
  teamUsage?: {
    onDemand?: UsageBucket;
  };
}

interface UsageBucket {
  enabled?: boolean;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  breakdown?: {
    included?: number | null;
    bonus?: number | null;
    total?: number | null;
  };
  totalPercentUsed?: number | null;
  autoPercentUsed?: number | null;
  apiPercentUsed?: number | null;
}

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";

function asNumberOrNull(value: unknown): number | null | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : value === null
      ? null
      : undefined;
}

function parseBucket(value: unknown): UsageBucket | undefined {
  if (!isRecord(value)) return undefined;
  const breakdown = isRecord(value.breakdown)
    ? {
        included: asNumberOrNull(value.breakdown.included),
        bonus: asNumberOrNull(value.breakdown.bonus),
        total: asNumberOrNull(value.breakdown.total),
      }
    : undefined;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    used: asNumberOrNull(value.used),
    limit: asNumberOrNull(value.limit),
    remaining: asNumberOrNull(value.remaining),
    breakdown,
    totalPercentUsed: asNumberOrNull(value.totalPercentUsed),
    autoPercentUsed: asNumberOrNull(value.autoPercentUsed),
    apiPercentUsed: asNumberOrNull(value.apiPercentUsed),
  };
}

export function parseCursorUsageSummary(value: unknown): CursorUsageSummary {
  if (!isRecord(value)) throw new Error("Cursor usage endpoint returned an invalid response");
  return {
    billingCycleStart:
      typeof value.billingCycleStart === "string" ? value.billingCycleStart : undefined,
    billingCycleEnd: typeof value.billingCycleEnd === "string" ? value.billingCycleEnd : undefined,
    membershipType: typeof value.membershipType === "string" ? value.membershipType : undefined,
    limitType: typeof value.limitType === "string" ? value.limitType : undefined,
    isUnlimited: typeof value.isUnlimited === "boolean" ? value.isUnlimited : undefined,
    individualUsage: isRecord(value.individualUsage)
      ? {
          plan: parseBucket(value.individualUsage.plan),
          onDemand: parseBucket(value.individualUsage.onDemand),
        }
      : undefined,
    teamUsage: isRecord(value.teamUsage)
      ? { onDemand: parseBucket(value.teamUsage.onDemand) }
      : undefined,
  };
}

export function parseConnectPeriodUsage(value: unknown): CursorUsageSummary {
  if (!isRecord(value))
    throw new Error("Cursor period usage endpoint returned an invalid response");

  const billingCycleStart =
    typeof value.billingCycleStart === "string"
      ? new Date(Number(value.billingCycleStart)).toISOString()
      : undefined;
  const billingCycleEnd =
    typeof value.billingCycleEnd === "string"
      ? new Date(Number(value.billingCycleEnd)).toISOString()
      : undefined;

  const planUsage = isRecord(value.planUsage) ? value.planUsage : undefined;
  const spendLimitUsage = isRecord(value.spendLimitUsage) ? value.spendLimitUsage : undefined;

  const limitType =
    typeof spendLimitUsage?.limitType === "string" ? spendLimitUsage.limitType : undefined;
  const totalPercentUsed = asNumberOrNull(planUsage?.totalPercentUsed);
  const autoPercentUsed = asNumberOrNull(planUsage?.autoPercentUsed);
  const apiPercentUsed = asNumberOrNull(planUsage?.apiPercentUsed);
  const includedSpend = asNumberOrNull(planUsage?.includedSpend);
  const limit = asNumberOrNull(planUsage?.limit);

  // Infer membership type from limitType or displayMessage or fallback to Pro
  let membershipType = "Pro";
  if (limitType === "user") membershipType = "Pro";
  else if (limitType === "team") membershipType = "Team";
  else if (typeof value.membershipType === "string") membershipType = value.membershipType;

  return {
    billingCycleStart,
    billingCycleEnd,
    membershipType,
    limitType,
    individualUsage: {
      plan: {
        enabled: true,
        used: includedSpend,
        limit,
        remaining:
          limit !== null &&
          limit !== undefined &&
          includedSpend !== null &&
          includedSpend !== undefined
            ? Math.max(0, limit - includedSpend)
            : undefined,
        totalPercentUsed,
        autoPercentUsed,
        apiPercentUsed,
      },
    },
  };
}

export async function getCursorUsageSummary(
  getAccessToken?: () => Promise<string>,
  sessionToken = cursorEnv("USAGE_SESSION_TOKEN"),
): Promise<CursorUsageSummary> {
  if (getAccessToken) {
    try {
      const accessToken = await getAccessToken();
      if (accessToken) {
        const response = await fetch(
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (response.ok) {
          return parseConnectPeriodUsage(await response.json());
        }
      }
    } catch {
      // Connect usage call failed; fall back to session token
    }
  }

  if (sessionToken) {
    const response = await fetch(USAGE_SUMMARY_URL, {
      headers: { Cookie: `WorkosCursorSessionToken=${sessionToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      return parseCursorUsageSummary(await response.json());
    }
  }

  throw new Error(
    "Not logged in to Cursor. Please log in with Cursor CLI ('cursor' / 'agent'), run /login cursor, or set CURSOR_USAGE_SESSION_TOKEN to check usage.",
  );
}

function formatDollars(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "unlimited" : `$${(cents / 100).toFixed(2)}`;
}

function renderProgressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function formatResetDate(dateStr: string | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.valueOf())) return "";
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  return `Resets ${day} ${month}`;
}

function formatPctLabel(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "0% used";
  return `${Math.round(pct)}% used`;
}

function capitalize(str: string): string {
  if (!str) return "Pro";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatCursorUsage(summary: CursorUsageSummary): string {
  const plan = summary.individualUsage?.plan;
  const onDemand = summary.individualUsage?.onDemand;
  const resetStr = formatResetDate(summary.billingCycleEnd);

  const planName = capitalize(summary.membershipType || "Pro");
  const headerLeft = `Usage • ${planName}`;
  const totalWidth = 60;
  const headerRight = resetStr
    ? resetStr.padStart(Math.max(1, totalWidth - headerLeft.length))
    : "";

  const lines = [
    `${headerLeft}${headerRight}`,
    "Monthly plan and on-demand usage",
    "",
    "Category        Current          Usage",
  ];

  const totalPct = plan?.totalPercentUsed ?? 0;
  lines.push(
    `Included        ${formatPctLabel(totalPct).padEnd(16)}${renderProgressBar(totalPct)}`,
  );

  if (plan?.autoPercentUsed !== undefined && plan.autoPercentUsed !== null) {
    lines.push(
      `  Auto          ${formatPctLabel(plan.autoPercentUsed).padEnd(16)}${renderProgressBar(plan.autoPercentUsed)}`,
    );
  }

  if (plan?.apiPercentUsed !== undefined && plan.apiPercentUsed !== null) {
    lines.push(
      `  API           ${formatPctLabel(plan.apiPercentUsed).padEnd(16)}${renderProgressBar(plan.apiPercentUsed)}`,
    );
  }

  const isOnDemandActive = Boolean(onDemand?.enabled && (onDemand.used ?? 0) > 0);
  lines.push(`On-Demand       ${isOnDemandActive ? formatDollars(onDemand?.used) : "Disabled"}`);
  lines.push("-".repeat(totalWidth));
  lines.push(
    isOnDemandActive
      ? `On-demand spend: ${formatDollars(onDemand?.used)}`
      : "On-demand usage is off",
  );
  lines.push("");
  lines.push("View in dashboard: cursor.com/dashboard?tab=usage");

  return lines.join("\n");
}
