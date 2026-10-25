import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WaypointClient, ApiError } from "../src/api/client";
import { ConnectionProbe, ConnectionStatus } from "../src/api/connectionProbe";

const metadata = {
  authenticated: true,
  default_backend: "future-agent",
  launch_targets: [],
  backends: [
    {
      id: "future-agent",
      label: "Future Agent",
      default_transport: "rpc",
      supported_transports: ["rpc", "tty"],
      transport_capabilities: { is_structured: true },
      account_profiles: [{ id: "work", label: "Work", config_dir_key: "PRIVATE_PATH" }],
      default_launch_env: { PRIVATE: "private-value" },
    },
  ],
  session_presets: [{ id: "p", name: "Default", is_default: true, spec: { args: ["private-argument"] } }],
  usage_provider_options: [{ id: "usage", label: "Usage", accounts: [{ account_key: "private-account" }] }],
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("authenticates against HTTP and whitelists bootstrap metadata", async () => {
  const requests: { url?: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") res.end(JSON.stringify({ status: "ok" }));
    else if (req.url === "/api/auth/login")
      res.end(JSON.stringify({ token: "fixture-token", expires_at: "2000-01-01" }));
    else if (req.url === "/api/me" && req.headers.authorization === "Bearer fixture-token")
      res.end(JSON.stringify(metadata));
    else {
      res.statusCode = 401;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new WaypointClient(`http://127.0.0.1:${address.port}`);
    await client.health();
    const token = await client.login("fixture-password");
    const result = await client.me(token);
    assert.equal(result.agents[0].id, "future-agent");
    assert.equal(result.agents[0].structured, true);
    assert.deepEqual(result.agents[0].profiles, [{ id: "work", label: "Work" }]);
    assert.ok(!JSON.stringify(result).includes("private-"));
    assert.equal(requests[0].authorization, undefined);
    assert.equal(requests[1].body, JSON.stringify({ password: "fixture-password" }));
    assert.equal(requests[2].authorization, "Bearer fixture-token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("handles auth failures without reflecting server details or secrets", async () => {
  const client = new WaypointClient("http://localhost", async () => respond({ detail: "private-password" }, 401));
  await assert.rejects(
    client.login("private-password"),
    (error: unknown) =>
      error instanceof ApiError && error.kind === "invalid-credentials" && !error.message.includes("private-password"),
  );
  await assert.rejects(
    client.me("private-token"),
    (error: unknown) => error instanceof ApiError && error.kind === "expired-token",
  );
});

test("handles unreachable, timeout, invalid JSON, incompatible catalogs and server errors", async () => {
  const cases: [typeof fetch, string][] = [
    [
      async () => {
        throw new Error("secret network detail");
      },
      "unreachable",
    ],
    [async () => new Response("not json"), "invalid-response"],
    [async () => respond({}, 500), "server-error"],
    [async () => respond({ authenticated: false }), "invalid-response"],
    [async () => respond({ authenticated: true, default_backend: "x", backends: [null] }), "invalid-response"],
  ];
  for (const [request, kind] of cases)
    await assert.rejects(
      new WaypointClient("http://localhost", request).me("token"),
      (error: unknown) => error instanceof ApiError && error.kind === kind && !error.message.includes("secret"),
    );
  const timeoutRequest: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => undefined, 100);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(
    new WaypointClient("http://localhost", timeoutRequest, 5).health(),
    (error: unknown) => error instanceof ApiError && error.kind === "unreachable",
  );
});

test("disallows redirect credential forwarding and propagates cancellation", async () => {
  let redirect: RequestInit["redirect"];
  const client = new WaypointClient("http://localhost", async (_url, options) => {
    redirect = options?.redirect;
    return respond({ status: "ok" });
  });
  await client.health();
  assert.equal(redirect, "error");
  const controller = new AbortController();
  controller.abort();
  const cancelled = new WaypointClient("http://localhost", async (_url, options) => {
    options?.signal?.throwIfAborted();
    return respond({});
  });
  await assert.rejects(cancelled.health(controller.signal), { name: "AbortError" });
});

test("optional catalogs work and unsigned health never calls authenticated endpoints", async () => {
  const result = await new WaypointClient("http://localhost", async () =>
    respond({ authenticated: true, default_backend: "codex", launch_targets: [] }),
  ).me("token");
  assert.deepEqual(result.agents, []);
  const calls: string[] = [];
  const statuses: ConnectionStatus[] = [];
  const client = new WaypointClient("http://localhost", async (url) => {
    calls.push(String(url));
    return respond({ status: "ok" });
  });
  await new ConnectionProbe().run(
    { id: "a", name: "A", apiUrl: "http://localhost" },
    (value) => statuses.push(value),
    client,
  );
  assert.deepEqual(calls, ["http://localhost/health"]);
  assert.equal(statuses.at(-1)?.kind, "signed-out");
});

test("switching servers ignores a stale response even when transport ignores abort", async () => {
  let resolveOld: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  const oldClient = new WaypointClient("http://old", async () => pending);
  const currentClient = new WaypointClient("http://new", async (url) =>
    respond(String(url).endsWith("/health") ? { status: "ok" } : metadata),
  );
  const probe = new ConnectionProbe();
  const oldStates: ConnectionStatus[] = [];
  const newStates: ConnectionStatus[] = [];
  const oldRun = probe.run(
    { id: "old", name: "Old", apiUrl: "http://old", token: "old" },
    (status) => oldStates.push(status),
    oldClient,
  );
  await probe.run(
    { id: "new", name: "New", apiUrl: "http://new", token: "new" },
    (status) => newStates.push(status),
    currentClient,
  );
  resolveOld(respond({ status: "ok" }));
  await oldRun;
  assert.deepEqual(oldStates, [{ kind: "loading" }]);
  assert.equal(newStates.at(-1)?.kind, "ready");
  probe.cancel();
});

test("cancelling a view ignores late authenticated metadata and failures", async () => {
  for (const fail of [false, true]) {
    let finish: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let started: () => void = () => undefined;
    const authenticatedRequestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = new WaypointClient("http://localhost", async (url) => {
      if (String(url).endsWith("/health")) return respond({ status: "ok" });
      started();
      return response;
    });
    const probe = new ConnectionProbe();
    const states: ConnectionStatus[] = [];
    const run = probe.run(
      { id: "a", name: "A", apiUrl: "http://localhost", token: "fixture-token" },
      (value) => states.push(value),
      client,
    );
    await authenticatedRequestStarted;
    probe.cancel();
    finish(fail ? respond({}, 401) : respond(metadata));
    await run;
    assert.deepEqual(states, [{ kind: "loading" }]);
  }
});

test("does not forward bearer credentials through an actual HTTP redirect", async () => {
  let forwarded = false;
  const server = createServer((req, res) => {
    if (req.url === "/api/me") {
      res.writeHead(302, { Location: "/capture" });
      res.end();
    } else {
      forwarded = true;
      res.end(JSON.stringify(metadata));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      new WaypointClient(`http://127.0.0.1:${address.port}`).me("fixture-token"),
      (error: unknown) => error instanceof ApiError && error.kind === "unreachable",
    );
    assert.equal(forwarded, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("session HTTP endpoints preserve encoded identity and raw event cursor semantics", async () => {
  const { sessionWire, eventWire } = await import("./fixtures/conversation");
  const requests: string[] = [];
  const client = new WaypointClient("https://example.com/proxy", async (url) => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith("/sessions")) return respond({ sessions: [sessionWire("a/b")] });
    if (path.includes("/events"))
      return respond({ events: [eventWire(9, "agent_output", "hello", "reply", "a/b")], has_more: false });
    return respond({ session: sessionWire("a/b") });
  });
  assert.equal((await client.sessions("fixture-token"))[0].id, "a/b");
  assert.equal((await client.session("fixture-token", "a/b")).id, "a/b");
  await client.events("fixture-token", "a/b", { before: 9 });
  await client.events("fixture-token", "a/b", { cursor: 109 });
  assert.ok(requests[1].endsWith("/api/sessions/a%2Fb"));
  assert.ok(requests[2].endsWith("/events?before_sequence=9"));
  assert.ok(requests[3].endsWith("?cursor=109"));
  await assert.rejects(
    new WaypointClient("http://localhost", async () => respond({}, 404)).session("token", "missing"),
    (error: unknown) => error instanceof ApiError && error.kind === "not-found",
  );
});
