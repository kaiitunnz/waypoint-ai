import { isRecord } from "../domain/connections";
import { parseMetadata, ServerMetadata } from "./contracts";
import { Session, EventsPage, parseSession, parseSessions, parseEventsPage } from "./sessions";

export type ApiErrorKind =
  "unreachable" | "invalid-credentials" | "expired-token" | "invalid-response" | "server-error" | "not-found";

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class WaypointClient {
  constructor(
    private readonly apiUrl: string,
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 12000,
  ) {}

  private async call(
    path: string,
    options: { token?: string; password?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.request(`${this.apiUrl}${path}`, {
        method: options.password !== undefined ? "POST" : "GET",
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.password !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.password !== undefined ? JSON.stringify({ password: options.password }) : undefined,
        redirect: "error",
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw path === "/api/auth/login"
          ? new ApiError("invalid-credentials", "The password was not accepted. Check it and try again.")
          : new ApiError("expired-token", "Your sign-in expired or was revoked. Sign in again to reconnect.");
      }
      if (response.status === 404)
        throw new ApiError(
          "not-found",
          "This session is no longer available on this server. Return to Search Sessions and refresh.",
        );
      if (!response.ok)
        throw new ApiError("server-error", `The server returned HTTP ${response.status}. Check the server and retry.`);
      try {
        return await response.json();
      } catch {
        throw new ApiError(
          "invalid-response",
          "The API returned an unexpected response. Check that the API URL points to Waypoint.",
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError(
        "unreachable",
        "Could not reach the API. Check its URL, network connection, and TLS certificate, then retry.",
      );
    }
  }

  async health(signal?: AbortSignal): Promise<void> {
    const payload = await this.call("/health", { signal });
    if (!isRecord(payload) || payload.status !== "ok")
      throw new ApiError("invalid-response", "This URL did not return Waypoint health information. Check the API URL.");
  }

  async login(password: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.call("/api/auth/login", { password, signal });
    if (!isRecord(payload) || typeof payload.token !== "string" || !payload.token)
      throw new ApiError("invalid-response", "The server did not return a sign-in token. Check the API URL.");
    return payload.token;
  }

  async me(token: string, signal?: AbortSignal): Promise<ServerMetadata> {
    const payload = await this.call("/api/me", { token, signal });
    try {
      return parseMetadata(payload);
    } catch {
      throw new ApiError(
        "invalid-response",
        "The server returned incompatible connection information. Check the Waypoint version and API URL.",
      );
    }
  }
  private async read<T>(
    path: string,
    token: string,
    signal: AbortSignal | undefined,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const value = await this.call(path, { token, signal });
    try {
      return parse(value);
    } catch {
      throw new ApiError(
        "invalid-response",
        "The server returned incompatible session information. Check the Waypoint version and retry.",
      );
    }
  }

  sessions(token: string, signal?: AbortSignal): Promise<Session[]> {
    return this.read("/api/sessions", token, signal, parseSessions);
  }

  session(token: string, id: string, signal?: AbortSignal): Promise<Session> {
    return this.read(`/api/sessions/${encodeURIComponent(id)}`, token, signal, (value) => {
      if (!isRecord(value)) throw new Error("Invalid session response");
      const session = parseSession(value.session);
      if (session.id !== id) throw new Error("Mismatched session");
      return session;
    });
  }

  events(
    token: string,
    id: string,
    options: { before?: number; cursor?: number } = {},
    signal?: AbortSignal,
  ): Promise<EventsPage> {
    const query = new URLSearchParams(
      options.cursor !== undefined
        ? { cursor: String(options.cursor) }
        : { messages: "40", ...(options.before !== undefined ? { before_sequence: String(options.before) } : {}) },
    );
    return this.read(`/api/sessions/${encodeURIComponent(id)}/events?${query}`, token, signal, (value) =>
      parseEventsPage(value, id),
    );
  }
}
