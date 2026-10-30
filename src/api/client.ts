import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { InteractionAction } from "../domain/interactions";
import { mimeType } from "../domain/compose";
import { ModelCatalog, parseModels } from "./models";
import { isRecord } from "../domain/connections";
import { parseMetadata, ServerMetadata } from "./contracts";
import { LaunchSettings, UsageProvider, parseLaunchSettings, parseUsageProviders } from "./settings";
import { Session, EventsPage, parseAttachment, parseSession, parseSessions, parseEventsPage } from "./sessions";
import { BlockSubmit, InboxItem, InboxPage, InboxStatus, parseInboxItem, parseInboxPage } from "./inbox";

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

const inboxDeleted = "This inbox item was deleted.";
const inboxUnsupported = "This server doesn't have the Waypoint inbox. Update Waypoint to use it.";

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
      // Waypoint answers 403 for protected sessions and paths, never for sign-in.
      if (response.status === 403) throw new ApiError("rejected", "Waypoint does not allow this.", undefined, 403);
      if (response.status === 401) {
        throw path === "/api/auth/login"
          ? new ApiError("invalid-credentials", "The password was not accepted. Check it and try again.")
          : new ApiError("expired-token", "Your sign-in expired or was revoked. Sign in again to reconnect.");
      }
      if (response.status === 404)
        throw new ApiError("not-found", "This session is no longer available on this server.");
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

  events(token: string, id: string, options: { before?: number } = {}, signal?: AbortSignal): Promise<EventsPage> {
    // Pages use the server's message page size, the same one Waypoint's web app uses. Waypoint's
    // `cursor` read returns every later event in one response, which a long session cannot afford.
    const query = new URLSearchParams(
      options.before !== undefined ? { before_sequence: String(options.before) } : {},
    ).toString();
    return this.read(
      `/api/sessions/${encodeURIComponent(id)}/events${query ? `?${query}` : ""}`,
      token,
      signal,
      (value) => parseEventsPage(value, id),
    );
  }
  mutate(
    token: string,
    path: string,
    body?: Record<string, unknown>,
    options: { method?: "POST" | "PATCH" | "DELETE"; timeoutMs?: number } = {},
  ): Promise<Session> {
    return this.send(token, path, body, options, (value) => {
      if (!isRecord(value)) throw new Error("Invalid mutation response");
      return parseSession(value.session);
    });
  }
  // A response that doesn't parse leaves the outcome uncertain, since the server may have applied it.
  private async send<T>(
    token: string,
    path: string,
    body: Record<string, unknown> | undefined,
    options: { method?: "POST" | "PATCH" | "DELETE"; timeoutMs?: number },
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      const response = await this.request(`${this.apiUrl}${path}`, {
        method: options.method ?? "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
      if (response.status === 401)
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
        throw new ApiError(
          "not-found",
          "This session is unavailable. Start an explicit New Chat; your draft is kept.",
          undefined,
          404,
          isRecord(value) && typeof value.detail === "string" ? value.detail : undefined,
        );
      }
      if (response.status >= 400 && response.status < 500) {
        let detail = "";
        try {
          const value: unknown = await response.json();
          if (isRecord(value) && typeof value.detail === "string") detail = value.detail;
          else if (isRecord(value) && Array.isArray(value.detail)) detail = "invalid value";
        } catch {
          /* HTTP status still establishes rejection. */
        }
        const message =
          detail === "cwd-not-found"
            ? "The working directory does not exist on the execution target."
            : detail === "ssh-master-required"
              ? "Connect this SSH target in Waypoint, then retry. Your draft is kept."
              : response.status === 403
                ? `Waypoint does not allow this${detail ? `: ${detail}` : "."}`
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
      return parse(await response.json());
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
  // Waypoint never sweeps a pinned upload, so whoever pins one deletes it when nothing references it.
  async uploadAttachment(token: string, id: string, path: string, size: number, signal?: AbortSignal, pin = false) {
    const form = new FormData();
    form.append("file", await openAsBlob(path, { type: mimeType(path) }), basename(path));
    if (pin) form.append("pin", "true");
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
    if (response.status === 401)
      throw new ApiError("expired-token", "Your sign-in expired. Sign in again; your draft is kept.");
    if (response.status === 403)
      throw new ApiError("rejected", `Waypoint does not allow uploading ${basename(path)}.`, undefined, 403);
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
    if (response.status === 401)
      throw new ApiError("expired-token", "Your sign-in expired. Sign in again, then connect.");
    if (response.status === 403) throw new ApiError("rejected", "Waypoint does not allow connecting this target.");
    if (response.status === 404) throw new ApiError("not-found", "This execution target is no longer available.");
    if (response.status === 400) throw new ApiError("rejected", "This execution target does not use a password.");
    if (!response.ok)
      throw new ApiError("server-error", `The server returned HTTP ${response.status}. Retry connecting.`);
    const value: unknown = await response.json().catch(() => undefined);
    if (!isRecord(value) || typeof value.connected !== "boolean")
      throw new ApiError("invalid-response", "The server returned an unexpected connection response.");
    return { connected: value.connected, detail: typeof value.detail === "string" ? value.detail : undefined };
  }
  action(token: string, id: string, action: "interrupt" | "reattach" | "terminate", timeoutMs?: number) {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/${action}`, undefined, { timeoutMs });
  }
  pin(token: string, id: string, pinned: boolean) {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/pin`, undefined, {
      method: pinned ? "POST" : "DELETE",
    });
  }
  // Waypoint deletes the transcript and any session worktree; it terminates a live session first.
  deleteSession(token: string, id: string, timeoutMs?: number): Promise<string> {
    return this.send(
      token,
      `/api/sessions/${encodeURIComponent(id)}`,
      undefined,
      { method: "DELETE", timeoutMs },
      (value) => {
        if (!isRecord(value) || value.deleted !== id) throw new Error("Invalid delete response");
        return id;
      },
    );
  }
  launchSettings(token: string, id: string, signal?: AbortSignal): Promise<LaunchSettings> {
    return this.read(`/api/sessions/${encodeURIComponent(id)}/launch-settings`, token, signal, parseLaunchSettings);
  }
  usageProviders(token: string, signal?: AbortSignal): Promise<UsageProvider[]> {
    return this.read("/api/usage-provider-options", token, signal, parseUsageProviders);
  }
  // One settings change. Restarting changes take longer than ordinary requests, so callers pass their timeout.
  updateSetting(
    token: string,
    id: string,
    setting: "title" | "launch-settings" | "mode" | "model" | "effort" | "usage-limit-source",
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Session> {
    return this.mutate(token, `/api/sessions/${encodeURIComponent(id)}/${setting}`, body, {
      method: ["title", "launch-settings", "usage-limit-source"].includes(setting) ? "PATCH" : "POST",
      timeoutMs,
    });
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
  private async inboxRead<T>(
    path: string,
    token: string,
    signal: AbortSignal | undefined,
    parse: (value: unknown) => T,
    missing = inboxUnsupported,
  ) {
    try {
      return await this.read(path, token, signal, parse);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "not-found") throw new ApiError("not-found", missing);
      if (error instanceof ApiError && error.kind === "invalid-response")
        throw new ApiError(
          "invalid-response",
          "The server returned incompatible inbox information. Check the Waypoint version and retry.",
        );
      throw error;
    }
  }
  inbox(
    token: string,
    query: { status: InboxStatus; q?: string; cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<InboxPage> {
    const params = new URLSearchParams({
      status: query.status,
      limit: String(query.limit),
      ...(query.q ? { q: query.q } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return this.inboxRead(`/api/inbox?${params}`, token, signal, parseInboxPage);
  }
  inboxItem(token: string, id: string, signal?: AbortSignal): Promise<InboxItem> {
    return this.inboxRead(
      `/api/inbox/${encodeURIComponent(id)}`,
      token,
      signal,
      (value) => {
        if (!isRecord(value)) throw new Error("Invalid inbox item response");
        const item = parseInboxItem(value.item);
        if (item.id !== id) throw new Error("Mismatched inbox item");
        return item;
      },
      inboxDeleted,
    );
  }
  inboxCount(token: string, signal?: AbortSignal): Promise<number> {
    return this.inboxRead("/api/inbox/unresolved-count", token, signal, (value) => {
      if (!isRecord(value) || typeof value.unresolved_count !== "number") throw new Error("Invalid inbox count");
      return value.unresolved_count;
    });
  }
  private async inboxSend<T>(
    token: string,
    path: string,
    body: Record<string, unknown> | undefined,
    method: "POST" | "DELETE",
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      return await this.send(token, path, body, { method }, parse);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.kind === "expired-token") throw new ApiError("expired-token", "Your sign-in expired. Sign in again.");
      if (error.kind === "not-found")
        throw new ApiError(
          "not-found",
          error.serverDetail === "inbox block not found"
            ? "This part of the item is no longer available. Refresh the inbox."
            : inboxDeleted,
          error.serverDetail === "inbox block not found" ? "block" : "item",
          404,
        );
      if (error.kind === "rejected" && error.status === 422)
        throw new ApiError(
          "rejected",
          `Waypoint did not accept this answer${error.serverDetail && error.serverDetail !== "invalid value" ? `: ${error.serverDetail}` : "."}`,
          undefined,
          422,
          error.serverDetail,
        );
      if (error.kind === "rejected")
        throw new ApiError(
          "rejected",
          `Waypoint rejected this inbox change${error.serverDetail ? `: ${error.serverDetail}` : "."}`,
          undefined,
          error.status,
          error.serverDetail,
        );
      throw error;
    }
  }
  answerInboxBlock(token: string, itemId: string, blockId: string, body: BlockSubmit): Promise<InboxItem> {
    return this.inboxSend(
      token,
      `/api/inbox/${encodeURIComponent(itemId)}/blocks/${encodeURIComponent(blockId)}`,
      body,
      "POST",
      (value) => {
        if (!isRecord(value)) throw new Error("Invalid inbox response");
        return parseInboxItem(value.item);
      },
    );
  }
  markInboxRead(token: string, id: string): Promise<InboxItem> {
    return this.inboxSend(token, `/api/inbox/${encodeURIComponent(id)}/read`, undefined, "POST", (value) => {
      if (!isRecord(value)) throw new Error("Invalid inbox response");
      return parseInboxItem(value.item);
    });
  }
  deleteInboxItem(token: string, id: string): Promise<string> {
    return this.inboxSend(token, `/api/inbox/${encodeURIComponent(id)}`, undefined, "DELETE", (value) => {
      if (!isRecord(value) || value.deleted !== true) throw new Error("Invalid delete response");
      return id;
    });
  }
  deleteResolvedInbox(token: string): Promise<string[]> {
    return this.inboxSend(token, "/api/inbox/delete-resolved", undefined, "POST", (value) => {
      if (!isRecord(value) || !Array.isArray(value.deleted_ids)) throw new Error("Invalid delete response");
      return value.deleted_ids.filter((id): id is string => typeof id === "string");
    });
  }
  models(token: string, backend: string, target: string, profile: string, signal?: AbortSignal): Promise<ModelCatalog> {
    const query = new URLSearchParams({
      ...(target ? { launch_target_id: target } : {}),
      ...(profile && profile !== "__default__" ? { account_profile_id: profile } : {}),
    });
    return this.read(`/api/backends/${encodeURIComponent(backend)}/models?${query}`, token, signal, parseModels);
  }
}
