import { InteractionAction } from "../domain/interactions";
import { ModelCatalog, parseModels } from "./models";
import { isRecord } from "../domain/connections";
import { parseMetadata, ServerMetadata } from "./contracts";
import { Session, EventsPage, parseSession, parseSessions, parseEventsPage } from "./sessions";

export type ApiErrorKind =
  | "unreachable"
  | "invalid-credentials"
  | "expired-token"
  | "invalid-response"
  | "server-error"
  | "not-found"
  | "rejected"
  | "uncertain";

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly detail?: string,
    public readonly status?: number,
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
  async mutate(token: string, path: string, body?: Record<string, unknown>): Promise<Session> {
    try {
      const response = await this.request(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 401 || response.status === 403)
        throw new ApiError("expired-token", "Your sign-in expired. Sign in again; the draft is kept.");
      if (response.status === 404)
        throw new ApiError("not-found", "This session is unavailable. Start an explicit New Chat; your draft is kept.");
      if (response.status >= 400 && response.status < 500) {
        let detail = "";
        try {
          const value: unknown = await response.json();
          if (isRecord(value) && typeof value.detail === "string") detail = value.detail;
        } catch {
          /* HTTP status still establishes rejection. */
        }
        const message =
          detail === "cwd-not-found"
            ? "The working directory does not exist on the execution target. Update Quick Chat Defaults."
            : detail === "ssh-master-required"
              ? "Connect this SSH target in Waypoint, then retry. Your draft is kept."
              : response.status === 409
                ? "Waypoint rejected this operation because the session is busy or waiting for an interaction. Review it and retry; your draft is kept."
                : "Waypoint rejected this operation. Check the selected agent, target, and launch settings; your draft is kept.";
        throw new ApiError(
          "rejected",
          message,
          ["cwd-not-found", "ssh-master-required"].includes(detail) ? detail : undefined,
          response.status,
        );
      }
      if (!response.ok)
        throw new ApiError(
          "uncertain",
          "Waypoint may have processed this operation, but its result was not confirmed. Check the outcome before retrying.",
        );
      const value: unknown = await response.json();
      if (!isRecord(value)) throw new Error("Invalid mutation response");
      return parseSession(value.session);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "uncertain",
        "The connection ended before the operation was confirmed. It may have reached Waypoint. Check the outcome before retrying.",
      );
    }
  }
  create(token: string, request: Record<string, unknown>) {
    return this.mutate(token, "/api/sessions", request);
  }
  input(token: string, id: string, text: string) {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/input`, { text, submit: true });
  }
  action(token: string, id: string, action: "interrupt" | "reattach") {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/${action}`);
  }
  // Some agents report upstream failures as HTTP 400 after the response may have been delivered,
  // so only statuses Waypoint returns before dispatch count as definitive rejections.
  async interaction(token: string, id: string, action: InteractionAction, body: Record<string, unknown>) {
    let session: Session;
    try {
      session = await this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/${action}`, body);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "expired-token")
        throw new ApiError("expired-token", "Your sign-in expired. Sign in again; your response is kept.");
      if (error instanceof ApiError && error.kind === "not-found")
        throw new ApiError("not-found", "This session is no longer available on this server. Your response is kept.");
      if (error instanceof ApiError && error.kind === "rejected" && [409, 422].includes(error.status ?? 0))
        throw new ApiError(
          "rejected",
          "Waypoint did not accept this response yet. Respond to any pending approval, refresh, and try again; your response is kept.",
          undefined,
          error.status,
        );
      throw new ApiError(
        "uncertain",
        "Waypoint did not confirm this response. It may have reached the agent. Check the outcome before trying again.",
      );
    }
    if (session.id !== id)
      throw new ApiError(
        "uncertain",
        "Waypoint did not confirm this response. It may have reached the agent. Check the outcome before trying again.",
      );
    return session;
  }
  models(token: string, backend: string, target: string, profile: string, signal?: AbortSignal): Promise<ModelCatalog> {
    const query = new URLSearchParams({
      ...(target ? { launch_target_id: target } : {}),
      ...(profile && profile !== "__default__" ? { account_profile_id: profile } : {}),
    });
    return this.read(`/api/backends/${encodeURIComponent(backend)}/models?${query}`, token, signal, parseModels);
  }
}
