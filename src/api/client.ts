import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { InteractionAction } from "../domain/interactions";
import { mimeType } from "../domain/compose";
import { ModelCatalog, parseModels } from "./models";
import { isRecord } from "../domain/connections";
import { parseMetadata, ServerMetadata } from "./contracts";
import { Session, EventsPage, parseAttachment, parseSession, parseSessions, parseEventsPage } from "./sessions";

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
    public readonly serverDetail?: string,
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
    options: { token?: string; password?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
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
    timeoutMs?: number,
  ): Promise<T> {
    const value = await this.call(path, { token, signal, timeoutMs });
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
    // Cursor reads return every later event in one response, so they get more time.
    return this.read(
      `/api/sessions/${encodeURIComponent(id)}/events?${query}`,
      token,
      signal,
      (value) => parseEventsPage(value, id),
      options.cursor !== undefined ? this.timeoutMs * 5 : undefined,
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
      if (response.status === 404) {
        const value: unknown = await response.json().catch(() => undefined);
        // Waypoint checks attachment IDs before recording input.
        if (isRecord(value) && typeof value.detail === "string" && value.detail.startsWith("attachment not found"))
          throw new ApiError(
            "rejected",
            "An attachment expired. Send again to upload it again.",
            "attachment-missing",
            404,
          );
        throw new ApiError("not-found", "This session is unavailable. Start an explicit New Chat; your draft is kept.");
      }
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
          detail,
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
  input(token: string, id: string, text: string, attachments: string[] = []) {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/input`, {
      text,
      submit: true,
      ...(attachments.length ? { attachments } : {}),
    });
  }
  // Uploads are not inputs: an unconfirmed upload can only leave an orphan, so failures stay retryable.
  async uploadAttachment(token: string, id: string, path: string, size: number, signal?: AbortSignal) {
    const form = new FormData();
    form.append("file", await openAsBlob(path, { type: mimeType(path) }), basename(path));
    const timeout = AbortSignal.timeout(30000 + Math.ceil(size / 262144) * 1000);
    let response: Response;
    try {
      response = await this.request(`${this.apiUrl}/api/sessions/${encodeURIComponent(id)}/attachments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      throw new ApiError("unreachable", `Could not upload ${basename(path)}. Check the connection and send again.`);
    }
    if (response.status === 401 || response.status === 403)
      throw new ApiError("expired-token", "Your sign-in expired. Sign in again; your draft is kept.");
    if (response.status === 404)
      throw new ApiError("not-found", "This session is unavailable. Start a new chat; your draft is kept.");
    if (response.status === 413)
      throw new ApiError("rejected", `${basename(path)} is larger than this server accepts.`, undefined, 413);
    if (!response.ok)
      throw new ApiError(
        "server-error",
        `Could not upload ${basename(path)}. The server returned HTTP ${response.status}.`,
      );
    try {
      return parseAttachment(await response.json());
    } catch {
      throw new ApiError("invalid-response", "The server returned an unexpected upload response.");
    }
  }
  async deleteAttachment(token: string, id: string, attachmentId: string) {
    const response = await this.request(
      `${this.apiUrl}/api/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok && response.status !== 404) throw new ApiError("server-error", "Could not remove the upload.");
  }
  attachments(token: string, id: string, signal?: AbortSignal): Promise<string[]> {
    return this.read(`/api/sessions/${encodeURIComponent(id)}/attachments`, token, signal, (value) => {
      if (!Array.isArray(value)) throw new Error("Invalid attachment list");
      return value.map((item) => parseAttachment(item).id);
    });
  }
  async connectTarget(
    token: string,
    targetId: string,
    password: string,
  ): Promise<{ connected: boolean; detail?: string }> {
    let response: Response;
    try {
      response = await this.request(`${this.apiUrl}/api/launch-targets/${encodeURIComponent(targetId)}/connect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new ApiError(
        "unreachable",
        "Could not reach Waypoint to connect the target. Check the connection and retry.",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new ApiError("expired-token", "Your sign-in expired. Sign in again, then connect.");
    if (response.status === 404) throw new ApiError("not-found", "This execution target is no longer available.");
    if (response.status === 400) throw new ApiError("rejected", "This execution target does not use a password.");
    if (!response.ok)
      throw new ApiError("server-error", `The server returned HTTP ${response.status}. Retry connecting.`);
    const value: unknown = await response.json().catch(() => undefined);
    if (!isRecord(value) || typeof value.connected !== "boolean")
      throw new ApiError("invalid-response", "The server returned an unexpected connection response.");
    return { connected: value.connected, detail: typeof value.detail === "string" ? value.detail : undefined };
  }
  action(token: string, id: string, action: "interrupt" | "reattach") {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/${action}`);
  }
  // Some agents report upstream failures as HTTP 400 after the response may have been delivered, so a
  // 400 is definitive only when its detail proves Waypoint rejected it before dispatch.
  async interaction(
    token: string,
    id: string,
    action: InteractionAction,
    body: Record<string, unknown>,
    preDispatch: string[] = [],
  ) {
    let session: Session;
    try {
      session = await this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/${action}`, body);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "expired-token")
        throw new ApiError("expired-token", "Your sign-in expired. Sign in again; your response is kept.");
      if (error instanceof ApiError && error.kind === "not-found")
        throw new ApiError("not-found", "This session is no longer available on this server. Your response is kept.");
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        preDispatch.some((detail) => error.serverDetail?.startsWith(detail))
      )
        throw new ApiError(
          "rejected",
          "This request is no longer pending. Refresh the conversation; your response is kept.",
          undefined,
          400,
        );
      if (error instanceof ApiError && error.kind === "rejected" && error.status === 409)
        throw new ApiError(
          "rejected",
          "Waypoint is busy with this request or waiting for something else first, such as an approval or the agent starting. An earlier response may still be in progress. Refresh before trying again; your response is kept.",
          undefined,
          409,
        );
      if (error instanceof ApiError && error.kind === "rejected" && error.status === 422)
        throw new ApiError(
          "rejected",
          "Waypoint did not accept this response. Refresh the request; your response is kept.",
          undefined,
          422,
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
