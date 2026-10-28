import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaypointClient } from "../src/api/client";
import { parseMetadata } from "../src/api/contracts";
import { ChatDefaults, createRequest, customLaunch, initialDefaults, launchFingerprint } from "../src/domain/quickChat";
import { QuickChatController } from "../src/hooks/quickChatController";
import { launchSession } from "../src/hooks/sessionLauncher";
import { SessionManager } from "../src/hooks/sessionManager";
import { draftKeys } from "../src/storage/drafts";
import { ServerMutex } from "../src/storage/mutex";
import { QuickChatStore, decodeQuickChat, isChatLaunchFields, restoreLaunchDraft } from "../src/storage/quickChat";
import { Workspace } from "../src/storage/workspace";
import { metadataWire, sessionWire } from "./fixtures/conversation";

const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const connection = { id: "server-a", apiUrl: "http://localhost", name: "A", token: "fixture-token" };
const minute = 60000;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "new-session-"));
  const values = new Map<string, string>();
  const storage = { failAfterCreate: false, failLaunchDraft: false };
  const store = new QuickChatStore(
    {
      keys: async () => [...values.keys()],
      removeItem: async (key) => void values.delete(key),
      getItem: async (key) => values.get(key),
      setItem: async (key, value) => {
        if (storage.failLaunchDraft && key === draftKeys.launch(connection.id)) {
          storage.failLaunchDraft = false;
          throw new Error("Storage unavailable");
        }
        // Fails the write that records a confirmed create: the pointer moving while a create is cleared.
        if (storage.failAfterCreate && key.startsWith("waypoint.quick-chat.")) {
          const state = JSON.parse(value);
          if (state.pointer && !state.pending) {
            storage.failAfterCreate = false;
            throw new Error("Storage unavailable");
          }
        }
        values.set(key, value);
      },
    },
    new ServerMutex(directory),
  );
  const metadata = {
    ...metadataWire,
    default_cwd: "/workspace",
    launch_targets: [
      {
        id: "ssh-1",
        name: "Build Box",
        kind: "ssh",
        auth: "password",
        connected: false,
        supported_backends: ["test-agent"],
      },
    ],
  };
  const server = {
    sessions: [] as (ReturnType<typeof sessionWire> & { tags?: Record<string, string>; created_at?: string })[],
    creates: [] as Record<string, unknown>[],
    inputs: [] as { session: string; text: string }[],
    connects: [] as string[],
    create: "ok" as "ok" | "reject" | "uncertain" | "ssh",
  };
  let now = 1_000_000;
  const client = new WaypointClient(connection.apiUrl, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/api/me") return respond(metadata);
    if (path.startsWith("/api/launch-targets/")) {
      server.connects.push(String(body.password));
      return respond({ target_id: "ssh-1", connected: true });
    }
    if (path === "/api/sessions" && init?.method === "POST") {
      if (server.create === "reject") return respond({ detail: "preset blocked by policy" }, 400);
      if (server.create === "ssh") return respond({ detail: "ssh-master-required" }, 409);
      server.creates.push(body);
      const session = {
        ...sessionWire(`created-${server.creates.length}`),
        status: "idle",
        tags: body.tags as Record<string, string>,
        cwd: String(body.cwd),
        model: String(body.model ?? "test-model"),
      };
      server.sessions.push(session);
      if (server.create === "uncertain") throw new Error("connection reset");
      return respond({ session });
    }
    if (path === "/api/sessions") return respond({ sessions: server.sessions });
    const id = decodeURIComponent(path.split("/")[3]);
    const session = server.sessions.find((item) => item.id === id);
    if (!session) return respond({}, 404);
    if (path.endsWith("/events"))
      return respond({
        events: [],
        has_more: false,
        pending_questions: { questions: [], as_of_sequence: 0, revision: 0 },
      });
    if (path.endsWith("/input")) {
      server.inputs.push({ session: id, text: String(body.text) });
      return respond({ session });
    }
    if (path.endsWith("/terminate")) {
      session.status = "exited";
      return respond({ session });
    }
    return respond({ session });
  });
  const controller = (forceNew = false, resume = false, workspace?: Workspace) =>
    new QuickChatController(
      connection,
      store,
      async () => undefined,
      { forceNew, resume, workspace },
      client,
      () => now,
    );
  const setDefaults = (patch: Partial<ChatDefaults>) =>
    store.transaction(connection.id, async (saved, persist) => {
      saved.defaults = { ...saved.defaults, ...patch };
      await persist();
    });
  const settings = async (patch: Partial<ChatDefaults> = {}) => ({
    ...(await store.load(connection.id)).defaults,
    model: "chosen-model",
    cwd: "/chosen",
    ...patch,
  });
  return {
    store,
    storage,
    values,
    server,
    client,
    metadata: parseMetadata(metadata),
    controller,
    setDefaults,
    settings,
    advance: (ms: number) => (now += ms),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("starting a session from chosen settings creates it without a message and leaves the defaults", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await f.store.drafts.write(draftKeys.launch(connection.id), JSON.stringify(await f.settings()));
  const result = await c.createSession(await f.settings(), "launch-form");
  assert.equal(result.kind, "created");
  assert.equal(f.server.creates.length, 1);
  assert.equal(f.server.creates[0].model, "chosen-model");
  assert.equal(f.server.creates[0].cwd, "/chosen");
  assert.deepEqual(f.server.inputs, []);
  const saved = await f.store.load(connection.id);
  assert.equal(saved.defaults.cwd, "");
  assert.equal(saved.defaults.model, "");
  assert.equal(saved.pointer, "created-1");
  assert.equal(saved.chosen?.sessionId, "created-1");
  assert.equal(saved.compose?.quick?.launch, customLaunch);
  assert.equal(await f.store.drafts.read(draftKeys.launch(connection.id)), "");
  const state = c.getSnapshot();
  assert.equal(state.session?.id, "created-1");
  assert.equal(state.loading, false);
  assert.equal(state.compose.launch, customLaunch);
  c.changeDraft("hello");
  assert.equal(await c.send(), true);
  assert.equal(f.server.creates.length, 1);
  assert.deepEqual(f.server.inputs, [{ session: "created-1", text: "hello" }]);
  await f.close();
});

test("an edit-started session leaves the New Session with Settings draft alone", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await f.store.drafts.write(draftKeys.launch(connection.id), "{}");
  assert.equal((await c.createSession(await f.settings(), "edit")).kind, "created");
  assert.equal(await f.store.drafts.read(draftKeys.launch(connection.id)), "{}");
  await f.close();
});

test("an unused session from chosen settings is continued on reopen in every mode until its first message", async () => {
  for (const mode of ["new", "continue", "timed"] as const) {
    const f = await fixture();
    await f.setDefaults({ mode });
    const first = f.controller();
    await first.start();
    await first.createSession(await f.settings(), "launch-form");
    first.stop();
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().session?.id, "created-1", mode);
    reopened.changeDraft("hello");
    assert.equal(await reopened.send(), true);
    reopened.stop();
    if (mode === "new") {
      const later = f.controller();
      await later.start();
      assert.equal(later.getSnapshot().session, undefined, "Always New moves on after the first message");
    }
    await f.close();
  }
});

test("timed reuse counts the timeout from when the session was started", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  c.stop();
  f.advance(29 * minute);
  const within = f.controller();
  await within.start();
  assert.equal(within.getSnapshot().session?.id, "created-1");
  within.stop();
  f.advance(2 * minute);
  const after = f.controller();
  await after.start();
  assert.equal(after.getSnapshot().session, undefined);
  await f.close();
});

test("New Chat continues the session it started from chosen settings even though the defaults differ", async () => {
  const f = await fixture();
  const c = f.controller(true);
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  c.stop();
  const reopened = f.controller(true);
  await reopened.start();
  assert.equal(reopened.getSnapshot().session?.id, "created-1");
  reopened.changeDraft("hello");
  assert.equal(await reopened.send(), true);
  reopened.stop();
  const later = f.controller(true);
  await later.start();
  assert.equal(later.getSnapshot().session, undefined);
  await f.close();
});

test("Start New Chat moves on from an unused session in every mode, also after reopening", async () => {
  for (const mode of ["new", "continue", "timed"] as const) {
    const f = await fixture();
    await f.setDefaults({ mode });
    const c = f.controller();
    await c.start();
    await c.createSession(await f.settings(), "launch-form");
    await c.newChat();
    assert.equal(c.getSnapshot().session, undefined);
    assert.equal(c.getSnapshot().compose.launch, undefined);
    c.stop();
    const saved = await f.store.load(connection.id);
    assert.equal(saved.pointer, undefined, mode);
    assert.equal(saved.compose?.quick?.sessionId, undefined, mode);
    const reopened = f.controller();
    await reopened.start();
    assert.equal(reopened.getSnapshot().session, undefined, mode);
    await f.close();
  }
});

test("the binding never overrides Quick Chat's real destination", async () => {
  const f = await fixture();
  await f.setDefaults({ mode: "new" });
  const c = f.controller();
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  c.stop();
  // A New Chat send moves the destination to its own session.
  const other = f.controller(true);
  await other.start();
  other.changeDraft("elsewhere");
  assert.equal(await other.send(), true);
  other.stop();
  assert.equal((await f.store.load(connection.id)).pointer, "created-2");
  const reopened = f.controller();
  await reopened.start();
  assert.equal(reopened.getSnapshot().session, undefined);
  reopened.stop();
  // Use for Quick Chat on another session wins too.
  const manager = new SessionManager(connection, f.store, f.client, () => 1_000_000);
  f.server.sessions[0].status = "idle";
  assert.equal((await manager.useForQuickChat("created-1", f.metadata)).kind, "done");
  const resumed = f.controller(false, true);
  await resumed.start();
  assert.equal(resumed.getSnapshot().session?.id, "created-1");
  await f.close();
});

test("a line send that creates a session drops a custom binding to the previous one", async () => {
  const f = await fixture();
  await f.setDefaults({ mode: "new" });
  const c = f.controller();
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  await c.newChat();
  c.changeDraft("fresh");
  assert.equal(await c.send(), true);
  assert.equal(f.server.creates.length, 2);
  assert.equal((await f.store.load(connection.id)).compose?.quick?.launch, undefined);
  await f.close();
});

test("staging context and discarding a compose draft keep the binding", async () => {
  const f = await fixture();
  await f.setDefaults({ mode: "new" });
  const c = f.controller();
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  assert.equal(await c.stageContext("selection", "picked"), true);
  assert.equal((await f.store.load(connection.id)).compose?.quick?.launch, customLaunch);
  assert.equal(await c.discardCompose(), true);
  const saved = await f.store.load(connection.id);
  assert.equal(saved.compose?.quick?.sessionId, "created-1");
  assert.equal(saved.compose?.quick?.launch, customLaunch);
  c.stop();
  const reopened = f.controller();
  await reopened.start();
  assert.equal(reopened.getSnapshot().session?.id, "created-1");
  await f.close();
});

test("a rejected start keeps nothing and shows Waypoint's reason without blaming the defaults", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  f.server.create = "reject";
  const result = await c.createSession(await f.settings(), "launch-form");
  assert.deepEqual(result, { kind: "rejected", message: "Waypoint: preset blocked by policy" });
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.pointer, undefined);
  assert.equal(c.getSnapshot().session, undefined);
  assert.equal(c.getSnapshot().error, "Waypoint: preset blocked by policy");
  await f.close();
});

test("an unconfirmed start keeps its checkpoint, and recovery shows and binds the session", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  c.changeDraft("before");
  assert.equal(await c.send(), true);
  assert.equal(c.getSnapshot().session?.id, "created-1");
  await f.store.drafts.write(draftKeys.launch(connection.id), "{}");
  f.server.create = "uncertain";
  const result = await c.createSession(await f.settings(), "launch-form");
  assert.equal(result.kind, "uncertain");
  assert.equal(c.getSnapshot().pending?.origin, "launch-form");
  assert.equal(await f.store.drafts.read(draftKeys.launch(connection.id)), "{}");
  await assert.rejects(c.createSession(await f.settings(), "launch-form"), /needs checking/);
  f.server.create = "ok";
  await c.reconcile();
  const state = c.getSnapshot();
  assert.equal(state.session?.id, "created-2");
  assert.equal(state.pending, undefined);
  assert.equal(state.notice, "Recovered the new session.");
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pointer, "created-2");
  assert.equal(saved.compose?.quick?.launch, customLaunch);
  assert.equal(await f.store.drafts.read(draftKeys.launch(connection.id)), "");
  await f.close();
});

test("a recovered session times out from its attempt", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  f.server.create = "uncertain";
  await c.createSession(await f.settings(), "edit");
  f.server.create = "ok";
  await c.reconcile();
  c.stop();
  f.advance(31 * minute);
  const reopened = f.controller();
  await reopened.start();
  assert.equal(reopened.getSnapshot().session, undefined);
  await f.close();
});

test("a failed write after a confirmed create is unconfirmed, not rejected", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  f.storage.failAfterCreate = true;
  const result = await c.createSession(await f.settings(), "launch-form");
  assert.equal(result.kind, "uncertain");
  assert.equal((await f.store.load(connection.id)).pending?.kind, "create");
  await f.close();
});

test("a password SSH target asks to connect without retrying, and the next start creates once", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  f.server.create = "ssh";
  const result = await c.createSession(await f.settings({ target: "ssh-1", cwd: "/remote" }), "launch-form");
  assert.deepEqual(result, {
    kind: "ssh",
    targetId: "ssh-1",
    message: "Connect Build Box, then start the session again.",
  });
  assert.equal((await f.store.load(connection.id)).pending, undefined);
  f.server.create = "ok";
  assert.equal((await c.connectTargetOnly("ssh-1", "right")).connected, true);
  assert.equal(f.server.creates.length, 0);
  assert.equal(
    (await c.createSession(await f.settings({ target: "ssh-1", cwd: "/remote" }), "launch-form")).kind,
    "created",
  );
  assert.equal(f.server.creates.length, 1);
  await f.close();
});

test("starting a session clears a send's stale SSH retry", async () => {
  const f = await fixture();
  await f.setDefaults({ target: "ssh-1", cwd: "/remote" });
  const c = f.controller();
  await c.start();
  f.server.create = "ssh";
  c.changeDraft("old draft");
  assert.equal(await c.send(), false);
  assert.equal(c.getSnapshot().sshTarget, "ssh-1");
  f.server.create = "ok";
  assert.equal(
    (await c.createSession(await f.settings({ target: "", cwd: "/chosen" }), "launch-form")).kind,
    "created",
  );
  assert.equal(c.getSnapshot().sshTarget, undefined);
  assert.deepEqual(await c.connectTarget("right"), {
    connected: false,
    detail: "No execution target needs a connection.",
  });
  assert.deepEqual(f.server.inputs, []);
  await f.close();
});

test("a failed draft clear after a confirmed start still shows the session", async () => {
  const f = await fixture();
  const c = f.controller();
  await c.start();
  f.storage.failLaunchDraft = true;
  const result = await c.createSession(await f.settings(), "launch-form");
  assert.equal(result.kind, "created");
  assert.equal(c.getSnapshot().session?.id, "created-1");
  assert.equal(f.server.creates.length, 1);
  await f.close();
});

test("Always New doesn't continue a session a send created and left unused", async () => {
  const f = await fixture();
  await f.setDefaults({ mode: "new" });
  const c = f.controller();
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  c.stop();
  // As a compose send leaves it when the create succeeded but the message didn't go through.
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.compose!.quick!.launch = launchFingerprint(createRequest(saved.defaults, f.metadata, saved.installation, ""));
    await persist();
  });
  const reopened = f.controller();
  await reopened.start();
  assert.equal(reopened.getSnapshot().session, undefined);
  await f.close();
});

test("starting a session is refused while busy, loading, or unconfirmed, and allowed when the destination is gone", async () => {
  const f = await fixture();
  const loading = f.controller();
  await assert.rejects(loading.createSession(await f.settings(), "launch-form"), /still loading/);
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.pointer = "deleted-session";
    await persist();
  });
  const c = f.controller();
  await c.start();
  assert.match(c.getSnapshot().error ?? "", /no longer on this server/);
  assert.equal((await c.createSession(await f.settings(), "launch-form")).kind, "created");
  assert.equal(c.getSnapshot().error, undefined);
  await c.newChat();
  assert.equal((await f.store.load(connection.id)).pointer, undefined);
  await f.close();
});

test("an empty working directory on this Mac's server starts in the Quick Chat workspace", async () => {
  const f = await fixture();
  let ensured = 0;
  const workspace = { dir: "/Users/me/.waypoint-ai/workspace", ensure: async () => void ensured++ } as Workspace;
  const c = f.controller(false, false, workspace);
  await c.start();
  assert.equal((await c.createSession(await f.settings({ cwd: "" }), "launch-form")).kind, "created");
  assert.equal(ensured, 1);
  assert.equal(f.server.creates[0].cwd, workspace.dir);
  await f.close();
});

test("the browser path binds Quick Chat's draft and refuses while an operation is unconfirmed", async () => {
  const f = await fixture();
  await f.setDefaults({ mode: "new" });
  const deps = { connection, client: f.client, now: () => 1_000_000, metadata: f.metadata };
  const settings = await f.settings();
  const result = await launchSession(deps, f.store, async () => undefined, settings, "quick", "edit");
  assert.equal(result.kind, "created");
  assert.equal((await f.store.load(connection.id)).compose?.quick?.launch, customLaunch);
  const c = f.controller();
  await c.start();
  assert.equal(c.getSnapshot().session?.id, "created-1");
  await f.store.transaction(connection.id, async (saved, persist) => {
    saved.pending = {
      kind: "input",
      operationId: "op",
      sessionId: "created-1",
      text: "x",
      draftKey: "quick",
      startedAt: 1,
    };
    await persist();
  });
  await assert.rejects(
    launchSession(deps, f.store, async () => undefined, settings, "quick", "edit"),
    /outcome/,
  );
  await f.close();
});

test("terminating a custom-bound session releases its binding", async () => {
  const f = await fixture();
  await f.setDefaults({ mode: "new" });
  const c = f.controller();
  await c.start();
  await c.createSession(await f.settings(), "launch-form");
  const result = await c.terminate();
  assert.equal(result?.ended, true);
  const saved = await f.store.load(connection.id);
  assert.equal(saved.pointer, undefined);
  assert.equal(saved.compose?.quick?.sessionId, undefined);
  assert.equal(saved.compose?.quick?.launch, undefined);
  await f.close();
});

test("form-sourced validation errors don't point at Quick Chat Defaults", () => {
  const metadata = parseMetadata({ ...metadataWire, default_cwd: "" });
  assert.throws(
    () => createRequest(initialDefaults(), metadata, "i", "o", { source: "form" }),
    (error: Error) => error.message === "Set a working directory.",
  );
  assert.throws(
    () => createRequest(initialDefaults(), metadata, "i", "o"),
    (error: Error) => error.message === "Set a working directory in Quick Chat Defaults.",
  );
});

test("launch settings and create origins are validated when read back", () => {
  const launch: Record<string, unknown> = { ...initialDefaults() };
  delete launch.mode;
  delete launch.timeoutMinutes;
  assert.equal(isChatLaunchFields(launch), true);
  assert.equal(isChatLaunchFields({ ...launch, args: ["--x"] }), true);
  assert.equal(isChatLaunchFields({ ...launch, model: 3 }), false);
  assert.equal(isChatLaunchFields({ ...launch, config: [1] }), false);
  const state = (origin: unknown) =>
    JSON.stringify({
      version: 1,
      installation: "i",
      defaults: initialDefaults(),
      sentAt: {},
      drafts: {},
      pending: { kind: "create", operationId: "o", text: "", draftKey: "quick", startedAt: 1, origin },
    });
  assert.equal(decodeQuickChat(state("launch-form")).pending?.origin, "launch-form");
  assert.throws(() => decodeQuickChat(state("elsewhere")));
});

test("a restored form draft keeps overrides it removed off, and falls back to the defaults when unreadable", () => {
  const defaults: ChatDefaults = { ...initialDefaults(), agent: "codex", args: ["--x"], config: ["a=1"] };
  // Changing the agent clears the overrides; JSON then drops them from the saved draft.
  const edited: Record<string, unknown> = { ...defaults, agent: "claude", args: undefined, config: undefined };
  delete edited.mode;
  delete edited.timeoutMinutes;
  const restored = restoreLaunchDraft(defaults, JSON.stringify(edited));
  assert.equal(restored.agent, "claude");
  assert.equal(restored.args, undefined);
  assert.equal(restored.config, undefined);
  assert.equal(restored.mode, defaults.mode);
  assert.deepEqual(restoreLaunchDraft(defaults, JSON.stringify({ ...edited, args: ["--y"] })).args, ["--y"]);
  assert.equal(restoreLaunchDraft(defaults, ""), defaults);
  assert.equal(restoreLaunchDraft(defaults, "{not json"), defaults);
  assert.equal(restoreLaunchDraft(defaults, JSON.stringify({ model: 3 })), defaults);
});
