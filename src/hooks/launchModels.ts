import { WaypointClient } from "../api/client";
import { ModelCatalog } from "../api/models";

export type LaunchModelDiscovery = { blocked: true; catalog?: never } | { blocked: false; catalog: ModelCatalog };

export async function discoverLaunchModels(
  client: Pick<WaypointClient, "me" | "models">,
  token: string,
  backend: string,
  target: string,
  profile: string,
  passwordTarget: boolean,
  signal?: AbortSignal,
): Promise<LaunchModelDiscovery> {
  // Waypoint substitutes local discovery while a password target is disconnected.
  if (passwordTarget) {
    const fresh = await client.me(token, signal);
    if (!fresh.targets.some((entry) => entry.id === target && entry.connected)) return { blocked: true };
  }
  return { blocked: false, catalog: await client.models(token, backend, target, profile, signal) };
}
