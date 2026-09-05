export const HEALTH_CHECK_AREAS = [
  "source files",
  "Supabase RPCs",
  "Edge Functions",
  "frontend secret scan",
  "admin draft protection",
];

export function sourceHealthSummary({
  requiredFiles = 0,
  requiredRpcs = 0,
  edgeFunctions = 0,
  warnings = 0,
} = {}) {
  return [
    `Required files checked: ${requiredFiles}`,
    `Required RPCs checked: ${requiredRpcs}`,
    `Edge Functions checked: ${edgeFunctions}`,
    `Warnings: ${warnings}`,
  ];
}

export function readinessBadge({ failures = [], warnings = [] } = {}) {
  if (failures.length) return "blocked";
  if (warnings.length) return "needs-review";
  return "ready";
}
