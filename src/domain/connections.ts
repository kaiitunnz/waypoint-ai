export interface Connection {
  id: string;
  name: string;
  apiUrl: string;
  frontendUrl?: string;
  token?: string;
}

export interface ConnectionInput {
  name: string;
  apiUrl: string;
  frontendUrl?: string;
}

export interface ConnectionState {
  version: 1;
  connections: Connection[];
  defaultId?: string;
  activeId?: string;
}

export function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete URL, such as https://waypoint.example.com.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use an HTTP or HTTPS URL without credentials, a query, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function normalizeConnection(input: ConnectionInput): ConnectionInput {
  const name = input.name.trim();
  if (!name) throw new Error("Give this server a name.");
  return {
    name,
    apiUrl: normalizeUrl(input.apiUrl),
    frontendUrl: input.frontendUrl?.trim() ? normalizeUrl(input.frontendUrl) : undefined,
  };
}

export function emptyState(): ConnectionState {
  return { version: 1, connections: [] };
}

export function decodeState(raw: string | undefined): ConnectionState {
  if (raw === undefined) return emptyState();
  const message = "Saved server data could not be read. Restore the extension's saved data before making changes.";
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.connections)) throw new Error(message);
    const ids = new Set<string>();
    const urls = new Set<string>();
    const connections = value.connections.map((item: unknown): Connection => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.name !== "string" ||
        typeof item.apiUrl !== "string" ||
        (item.frontendUrl !== undefined && typeof item.frontendUrl !== "string") ||
        (item.token !== undefined && typeof item.token !== "string")
      )
        throw new Error(message);
      const normalized = normalizeConnection({ name: item.name, apiUrl: item.apiUrl, frontendUrl: item.frontendUrl });
      if (ids.has(item.id) || urls.has(normalized.apiUrl)) throw new Error(message);
      ids.add(item.id);
      urls.add(normalized.apiUrl);
      return { ...normalized, id: item.id, token: item.token };
    });
    const defaultId =
      typeof value.defaultId === "string" && ids.has(value.defaultId) ? value.defaultId : connections[0]?.id;
    const activeId = typeof value.activeId === "string" && ids.has(value.activeId) ? value.activeId : defaultId;
    return { version: 1, connections, defaultId, activeId };
  } catch {
    throw new Error(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
