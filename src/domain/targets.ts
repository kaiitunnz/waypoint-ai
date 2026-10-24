import type { ExecutionTarget } from "../api/contracts";

export function targetConnectionLabel(target: ExecutionTarget): string {
  if (target.auth === "key") return "Key authentication";
  return target.connected ? "Connected" : "Password connection required";
}
