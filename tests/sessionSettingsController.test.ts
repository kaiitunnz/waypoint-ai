import assert from "node:assert/strict";
import { test } from "node:test";
import { WaypointClient } from "../src/api/client";
import { SettingsDraft, settingsDraft } from "../src/domain/sessionSettings";
import { SessionSettingsController, restartTimeoutMs } from "../src/hooks/sessionSettingsController";
import { launchWire, metadataWire, sessionRecord } from "./fixtures/settings";

const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { method: string; path: string; body?: Record<string, unknown> };
type Handler = (call: Call, calls: Call[]) => Response | Promise<Response> | undefined;

function fakeWaypoint(
  options: { session?: Record<string, unknown>; launch?: Record<string, unknown>; handle?: Handler } = {},
) {
  const calls: Call[] = [];
  const timeouts: Record<string, number | undefined> = {};
  const world = {
    session: sessionRecord(options.session) as Record<string, unknown>,
    launch: launchWire(options.launch) as Record<string, unknown>,
    me: structuredClone(metadataWire) as typeof metadataWire,
  };
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const call: Call = {
      method: init?.method ?? "GET",
      path: pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handled = await options.handle?.(call, calls);
    if (handled) return handled;
    const setting = pathname.replace("/api/sessions/s1/", "");
    if (pathname === "/api/me") return respond(world.me);
    if (pathname === "/api/usage-provider-options") return respond({ usage_provider_options: [] });
    if (pathname.startsWith("/api/backends/"))
      return respond({ models: [{ id: "gpt-a", label: "A" }], default_model_id: "gpt-a" });
    if (call.method === "GET" && pathname === "/api/sessions/s1") return respond({ session: world.session });
    if (call.method === "GET" && setting === "launch-settings") return respond(world.launch);
    const body = call.body ?? {};
    if (setting === "title") world.session = { ...world.session, title: body.title };
    else if (setting === "mode") world.session = { ...world.session, permission_mode: body.mode };
    else if (setting === "model") world.session = { ...world.session, model: body.model };
    else if (setting === "effort") world.session = { ...world.session, effort: body.effort };
    else if (setting === "launch-settings") {
      const keys = new Set(world.launch.launch_env_keys as string[]);
      for (const key of (body.env_unset as string[] | undefined) ?? []) keys.delete(key);
      for (const key of Object.keys((body.env_set as object | undefined) ?? {})) keys.add(key);
      world.launch = {
        ...world.launch,
        launch_env_keys: [...keys].sort(),
        ...(body.args ? { args: body.args } : {}),
        ...(body.config_overrides ? { config_overrides: body.config_overrides } : {}),
        ...("account_profile_id" in body ? { account_profile_id: body.account_profile_id } : {}),
      };
      world.session = { ...world.session, args: world.launch.args };
    } else if (setting !== "reattach") return respond({ detail: "unexpected" }, 500);
    return respond({ session: world.session });
  }) as typeof fetch;
  class RecordingClient extends WaypointClient {
    override updateSetting(...args: Parameters<WaypointClient["updateSetting"]>) {
      timeouts[args[2]] = args[4];
      return super.updateSetting(...args);
    }
  }
  const client = new RecordingClient(connection.apiUrl, request);
  let clock = 0;
  const controller = new SessionSettingsController(
    connection,
    "s1",
    client,
    async (ms) => {
      clock += ms;
    },
    () => clock,
  );
  const mutations = () => calls.filter((call) => call.method !== "GET");
  return { controller, calls, mutations, world, timeouts };
}

async function opened(waypoint: ReturnType<typeof fakeWaypoint>, edit: (draft: SettingsDraft) => SettingsDraft) {
  const baseline = await waypoint.controller.load();
  assert.ok(baseline);
  const draft = edit(settingsDraft(baseline));
  const plan = waypoint.controller.plan(draft)!;
  return { draft, plan };
}

const edits = (draft: SettingsDraft): SettingsDraft => ({
  ...draft,
  title: "Roses",
  profileId: null,
  args: "--slow",
  env: { ...draft.env, API_TOKEN: { op: "replace", value: "secret" } },
  permission: "plan",
  model: null,
  effort: "high",
  usage: { kind: "usage_provider", providerId: "p", accountKey: "k" },
});

test("applies changes in Waypoint's order with explicit nulls and restart timeouts", async () => {
  const waypoint = fakeWaypoint({
    handle: (call) =>
      call.path === "/api/usage-provider-options"
        ? respond({ usage_provider_options: [{ id: "p", label: "P", accounts: [{ account_key: "k" }] }] })
        : call.path.endsWith("usage-limit-source")
          ? respond({ session: sessionRecord({ usage_limit_source: "usage_provider" }) })
          : undefined,
  });
  const { draft, plan } = await opened(waypoint, edits);
  const prepared = await waypoint.controller.prepare(draft, plan);
  assert.equal(prepared.status, "ready");
  const result = await waypoint.controller.apply(draft, plan);
  assert.equal(result.status, "done");
  assert.deepEqual(
    waypoint.mutations().map((call) => [call.method, call.path.split("/").at(-1), call.body]),
    [
      ["PATCH", "title", { title: "Roses" }],
      [
        "PATCH",
        "launch-settings",
        { restart: true, account_profile_id: null, args: ["--slow"], env_set: { API_TOKEN: "secret" } },
      ],
      ["POST", "mode", { mode: "plan" }],
      ["POST", "model", { model: null }],
      ["POST", "effort", { effort: "high" }],
      [
        "PATCH",
        "usage-limit-source",
        { usage_limit_source: "usage_provider", usage_provider_id: "p", usage_provider_account_key: "k" },
      ],
    ],
  );
  assert.equal(waypoint.timeouts["launch-settings"], restartTimeoutMs);
  assert.equal(waypoint.timeouts.model, undefined);
  assert.ok(!JSON.stringify(waypoint.controller.getSnapshot()).includes("secret"));
});

test("a later failure reports earlier changes truthfully and replans only the rest", async () => {
  const waypoint = fakeWaypoint({
    handle: (call) => (call.path.endsWith("/model") ? respond({ detail: "model unavailable" }, 400) : undefined),
  });
  const { draft, plan } = await opened(waypoint, (base) => ({
    ...base,
    title: "Roses",
    model: "gpt-b",
    effort: "high",
    env: { ...base.env, API_TOKEN: { op: "replace", value: "secret" } },
    newEnv: [{ key: "EXTRA", value: "1" }],
  }));
  const result = await waypoint.controller.apply(draft, plan);
  assert.equal(result.status, "failed");
  const snapshot = waypoint.controller.getSnapshot();
  assert.deepEqual(snapshot.result?.applied, ["title", "launch settings"]);
  assert.equal(snapshot.result?.message, "Waypoint rejected the model change: model unavailable");
  assert.ok(!waypoint.mutations().some((call) => call.path.endsWith("/effort")));
  assert.ok(result.status === "failed");
  const replan = waypoint.controller.plan(result.draft)!;
  assert.deepEqual(
    replan.steps.map((step) => step.op),
    ["model", "effort"],
  );
  assert.equal(replan.restartCount, 0);
  assert.equal(snapshot.baseline?.title, "Roses");
});

test("lifecycle conflicts stop before anything else is sent", async () => {
  for (const [detail, message] of [
    ["another lifecycle operation is in progress for this session", /restarting or reattaching/],
    ["cannot change launch settings while the session is STARTING", /still starting/],
  ] as const) {
    const waypoint = fakeWaypoint({
      handle: (call) =>
        call.path.endsWith("launch-settings") && call.method === "PATCH" ? respond({ detail }, 409) : undefined,
    });
    const { draft, plan } = await opened(waypoint, (base) => ({ ...base, args: "--slow", effort: "high" }));
    const result = await waypoint.controller.apply(draft, plan);
    assert.equal(result.status, "failed");
    assert.match(waypoint.controller.getSnapshot().result!.message, message);
    assert.deepEqual(waypoint.controller.getSnapshot().result!.applied, []);
    assert.equal(waypoint.mutations().length, 1);
  }
});

test("an SSH target that needs its password is connected, then the remaining changes apply", async () => {
  let connected = false;
  const waypoint = fakeWaypoint({
    session: { launch_target_id: "box" },
    launch: { launch_target_id: "box" },
    handle: (call) => {
      if (call.path === "/api/launch-targets/box/connect") {
        connected = call.body?.password === "pw";
        return respond({ connected });
      }
      if (call.path.endsWith("launch-settings") && call.method === "PATCH" && !connected)
        return respond({ detail: "ssh-master-required" }, 409);
    },
  });
  const { draft, plan } = await opened(waypoint, (base) => ({ ...base, args: "--slow" }));
  const failed = await waypoint.controller.apply(draft, plan);
  assert.equal(failed.status, "failed");
  assert.equal(waypoint.controller.getSnapshot().connectTarget, "box");
  assert.match(waypoint.controller.getSnapshot().result!.message, /Connect Box/);
  assert.deepEqual(await waypoint.controller.connectTarget("box", "pw"), { connected: true, detail: undefined });
  assert.ok(failed.status === "failed");
  const retry = waypoint.controller.plan(failed.draft)!;
  assert.equal((await waypoint.controller.apply(failed.draft, retry)).status, "done");
  const patches = waypoint.mutations().filter((call) => call.path.endsWith("launch-settings"));
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[1].body, { restart: true, args: ["--slow"] });
});

test("a failed restore keeps the saved settings and offers reattach", async () => {
  const waypoint = fakeWaypoint({
    handle: (call) => {
      if (call.path.endsWith("launch-settings") && call.method === "PATCH") {
        waypoint.world.session = { ...waypoint.world.session, status: "exited", args: ["--slow"] };
        waypoint.world.launch = { ...waypoint.world.launch, args: ["--slow"] };
        return respond(
          { detail: "restore failed after applying launch settings (exited); settings kept, reattach to retry" },
          400,
        );
      }
    },
  });
  const { draft, plan } = await opened(waypoint, (base) => ({ ...base, args: "--slow", effort: "high" }));
  const result = await waypoint.controller.apply(draft, plan);
  const snapshot = waypoint.controller.getSnapshot();
  assert.equal(snapshot.reattach, true);
  assert.deepEqual(snapshot.result?.applied, ["launch settings"]);
  assert.ok(!waypoint.mutations().some((call) => call.path.endsWith("/effort")));
  assert.ok(result.status === "failed");
  assert.deepEqual(waypoint.controller.plan(result.draft)!.steps, []);
  await waypoint.controller.reattach();
  assert.equal(waypoint.mutations().at(-1)?.path, "/api/sessions/s1/reattach");
});

test("settings changed elsewhere stop the apply before any request", async () => {
  const waypoint = fakeWaypoint();
  const { draft, plan } = await opened(waypoint, (base) => ({ ...base, effort: "high" }));
  waypoint.world.session = { ...waypoint.world.session, title: "Renamed elsewhere" };
  const prepared = await waypoint.controller.prepare(draft, plan);
  assert.equal(prepared.status, "stale");
  assert.ok(prepared.status === "stale");
  assert.equal(prepared.draft.title, "Renamed elsewhere");
  assert.equal(prepared.draft.effort, "high");
  assert.equal(waypoint.mutations().length, 0);
});

test("capability changes in the server catalog are detected as stale", async () => {
  const waypoint = fakeWaypoint();
  const { draft, plan } = await opened(waypoint, (base) => ({ ...base, effort: "high" }));
  waypoint.world.me = {
    ...waypoint.world.me,
    backends: waypoint.world.me.backends.map((entry) =>
      entry.id === "codex"
        ? {
            ...entry,
            transport_capabilities: { ...entry.transport_capabilities, settings_change_interrupts_turn: true },
          }
        : entry,
    ),
  };
  assert.equal((await waypoint.controller.prepare(draft, plan)).status, "stale");
});

test("a session that exits or starts a turn after confirming is confirmed again", async () => {
  const exited = fakeWaypoint();
  const first = await opened(exited, (base) => ({ ...base, model: "gpt-b", title: "Roses" }));
  exited.world.session = { ...exited.world.session, status: "exited" };
  const prepared = await exited.controller.prepare(first.draft, first.plan);
  assert.equal(prepared.status, "changed");
  assert.ok(prepared.status === "changed");
  assert.match(prepared.message, /exited\. Reattach/);
  assert.equal(exited.mutations().length, 0);

  const busy = fakeWaypoint();
  const second = await opened(busy, (base) => ({ ...base, args: "--slow" }));
  const ready = await busy.controller.prepare(second.draft, second.plan);
  assert.ok(ready.status === "ready");
  assert.equal(ready.plan.interruptsTurn, false);
  busy.world.session = { ...busy.world.session, status: "running" };
  const result = await busy.controller.apply(second.draft, ready.plan);
  assert.equal(result.status, "reconfirm");
  assert.ok(result.status === "reconfirm");
  assert.equal(result.plan.interruptsTurn, true);
  assert.equal(busy.mutations().length, 0);
});

test("an unconfirmed restart waits for the session to settle and doesn't resend environment changes", async () => {
  let reads = 0;
  const waypoint = fakeWaypoint({
    handle: (call) => {
      if (call.path.endsWith("launch-settings") && call.method === "PATCH") throw new TypeError("connection reset");
      if (call.method === "GET" && call.path === "/api/sessions/s1" && waypoint.mutations().length) {
        reads++;
        return respond({ session: { ...waypoint.world.session, status: reads < 3 ? "starting" : "idle" } });
      }
    },
  });
  const { draft, plan } = await opened(waypoint, (base) => ({
    ...base,
    args: "--slow",
    env: { ...base.env, API_TOKEN: { op: "replace", value: "secret" } },
  }));
  const result = await waypoint.controller.apply(draft, plan);
  assert.ok(reads >= 3);
  assert.match(
    waypoint.controller.getSnapshot().result!.message,
    /didn't confirm the launch settings change.*Environment changes may have applied/s,
  );
  assert.ok(result.status === "failed");
  assert.equal(result.draft.env.API_TOKEN.op, "keep");
  assert.equal(result.draft.args, "--slow");
});

test("applied steps leave the draft even when the reload after a failure also fails", async () => {
  let failing = false;
  const waypoint = fakeWaypoint({
    handle: (call) => {
      if (call.path.endsWith("/model")) {
        failing = true;
        throw new TypeError("connection reset");
      }
      if (failing && call.method === "GET") throw new TypeError("connection reset");
    },
  });
  const { draft, plan } = await opened(waypoint, (base) => ({
    ...base,
    model: "gpt-b",
    env: { ...base.env, API_TOKEN: { op: "replace", value: "secret" } },
  }));
  const result = await waypoint.controller.apply(draft, plan);
  assert.ok(result.status === "failed");
  assert.deepEqual(result.applied, ["launch settings"]);
  assert.match(result.message, /didn't confirm the model change.*Reload Settings before applying again/s);
  assert.equal(result.draft.env.API_TOKEN.op, "keep");
  assert.deepEqual(
    waypoint.controller.plan(result.draft)!.steps.map((step) => step.op),
    ["model"],
  );
});

test("reattaching an SSH session that needs its password offers to connect", async () => {
  const waypoint = fakeWaypoint({
    session: { launch_target_id: "box", status: "exited" },
    launch: { launch_target_id: "box" },
    handle: (call) => (call.path.endsWith("/reattach") ? respond({ detail: "ssh-master-required" }, 409) : undefined),
  });
  await waypoint.controller.load();
  await waypoint.controller.reattach();
  const snapshot = waypoint.controller.getSnapshot();
  assert.equal(snapshot.connectTarget, "box");
  assert.equal(snapshot.result?.message, "Connect Box to restart this session, then reattach.");
});

test("a session that starts before applying blocks the launch change before any request", async () => {
  const waypoint = fakeWaypoint();
  const { draft, plan } = await opened(waypoint, (base) => ({ ...base, args: "--slow" }));
  waypoint.world.session = { ...waypoint.world.session, status: "starting" };
  const prepared = await waypoint.controller.prepare(draft, plan);
  assert.ok(prepared.status === "changed");
  assert.match(prepared.message, /still starting/);
  assert.equal(waypoint.mutations().length, 0);
});
