import assert from "node:assert/strict";
import { test } from "node:test";
import { runWhileActive } from "../src/hooks/runWhileActive";
import { ConnectionStore, StorageAdapter } from "../src/storage/connections";
import { parseMetadata } from "../src/api/contracts";
import { targetConnectionLabel } from "../src/domain/targets";

test("late connection and credential saves persist without navigating after the form closes", async () => {
  for (const operation of ["save", "authenticate"]) {
    const data = new Map<string, string>();
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delay = false;
    const adapter: StorageAdapter = {
      getItem: async (key) => data.get(key),
      setItem: async (key, value) => {
        if (delay) {
          started();
          await pending;
        }
        data.set(key, value);
      },
    };
    const store = new ConnectionStore(adapter);
    const connection = await store.save({ name: "Test", apiUrl: "http://localhost" });
    delay = true;
    const lifecycle = new AbortController();
    let navigated = false;
    const completion = (async () => {
      await runWhileActive(lifecycle.signal, async () => {
        if (operation === "save") await store.save({ name: "Renamed", apiUrl: connection.apiUrl }, connection.id);
        else await store.authenticate(connection.id, connection.apiUrl, "fixture-token");
      });
      navigated = true;
    })();
    await writing;
    lifecycle.abort();
    release();
    await assert.rejects(completion, { name: "AbortError" });
    assert.equal(navigated, false);
    const restored = (await store.read()).connections[0];
    assert.equal(
      operation === "save" ? restored.name : restored.token,
      operation === "save" ? "Renamed" : "fixture-token",
    );
  }
});

test("closing during refresh or toast suppresses remaining completion steps", async () => {
  for (const closeAt of [0, 1]) {
    const controller = new AbortController();
    const effects: string[] = [];
    const run = async () => {
      for (const [index, effect] of ["refresh", "toast"].entries()) {
        await runWhileActive(controller.signal, async () => {
          effects.push(effect);
          if (index === closeAt) controller.abort();
        });
      }
      effects.push("navigate");
    };
    await assert.rejects(run(), { name: "AbortError" });
    assert.deepEqual(effects, closeAt === 0 ? ["refresh"] : ["refresh", "toast"]);
  }
});

test("active forms complete normally and closed forms never start another operation", async () => {
  const controller = new AbortController();
  assert.equal(await runWhileActive(controller.signal, async () => "saved"), "saved");
  controller.abort();
  let called = false;
  await assert.rejects(
    runWhileActive(controller.signal, async () => {
      called = true;
    }),
    { name: "AbortError" },
  );
  assert.equal(called, false);
});

test("SSH key targets ignore password-connection cache and strip environment values", () => {
  const result = parseMetadata({
    authenticated: true,
    default_backend: "codex",
    launch_targets: [
      {
        id: "key",
        name: "Key Target",
        auth: "key",
        connected: false,
        default_launch_env_by_backend: { codex: { SECRET: "private-value" } },
      },
      { id: "password-offline", name: "Password Target", auth: "password", connected: false },
      { id: "password-online", name: "Connected Target", auth: "password", connected: true },
    ],
  });
  assert.deepEqual(result.targets.map(targetConnectionLabel), [
    "Key authentication",
    "Password connection required",
    "Connected",
  ]);
  assert.ok(!JSON.stringify(result).includes("private-value"));
});
