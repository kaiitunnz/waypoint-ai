import { isRecord } from "../domain/connections";
import { parseMetadata, ServerMetadata } from "./contracts";

export type ApiErrorKind =
  "unreachable" | "invalid-credentials" | "expired-token" | "invalid-response" | "server-error";

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
}
