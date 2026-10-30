import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetadata } from "../src/api/contracts";
import { parseModels } from "../src/api/models";
import { launchSettingsDisplay } from "../src/domain/launchSettings";
import { defaultEffort, defaultsModelChoices } from "../src/domain/modelOptions";
import { createRequest, initialDefaults } from "../src/domain/quickChat";
import { discoverLaunchModels } from "../src/hooks/launchModels";
import { metadataWire } from "./fixtures/settings";

const catalog = parseModels({
  default_model_id: "agent-model",
  default_model_label: "Agent Model",
  default_effort: "high",
  effort_levels: ["low", "medium", "high"],
  models: [
    { id: "agent-model", label: "Agent Model", supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
    { id: "preset-model", label: "Preset Model", supported_efforts: ["low", "high"], default_effort: "low" },
    { id: "fixed", label: "Fixed Model", supported_efforts: [], default_effort: "medium" },
  ],
});
const metadata = parseMetadata({
  ...metadataWire,
  default_cwd: "/server",
  default_preset_id: "team",
  backends: metadataWire.backends.map((agent) => ({
    ...agent,
    label: agent.id === "codex" ? "Coding Agent" : agent.label,
    account_profiles: [{ id: "work", label: "Work Account" }],
  })),
  session_presets: [
    {
      id: "team",
      name: "Team Preset",
      is_default: true,
      spec: {
        backend: "codex",
        transport: "codex_app_server",
        model: "preset-model",
        effort: "low",
        account_profile_id: "work",
        permission_mode: "plan",
      },
    },
  ],
});

test("launch fields show effective preset values without materializing overrides", () => {
  const values = initialDefaults();
  const before = JSON.stringify(values);
  const request = createRequest(values, metadata, "test-install", "test-operation");
  const display = launchSettingsDisplay(values, metadata, catalog);
  assert.equal(display.defaultPreset, "Team Preset · Server default");
  assert.equal(display.agent, "Coding Agent");
  assert.equal(display.transport, "Chat");
  assert.equal(display.model, "Preset Model");
  assert.equal(display.effort, "low");
  assert.equal(display.inheritedProfile, "Work Account");
  assert.equal(display.permission, "Plan");
  assert.equal(display.context.cwd, "/server");
  assert.equal(display.profile, "work");
  assert.equal(JSON.stringify(values), before);
  assert.deepEqual(createRequest(values, metadata, "test-install", "test-operation"), request);
  for (const field of ["model", "effort", "permission_mode", "account_profile_id"]) assert.ok(!(field in request));
});

test("agent default resets bypass preset without dropping explicit nulls", () => {
  const values = { ...initialDefaults(), model: "__default__", effort: "__default__", profile: "__default__" };
  const display = launchSettingsDisplay(values, metadata, catalog);
  assert.equal(display.defaultModel, "Agent Model");
  assert.equal(display.defaultEffort, "high");
  assert.equal(display.profile, "");
  // The inherited choices still show what selecting them would use.
  assert.equal(display.model, "Preset Model");
  assert.equal(display.inheritedProfile, "Work Account");
  const request = createRequest(values, metadata, "test-install", "test-operation");
  assert.equal(request.model, null);
  assert.equal(request.effort, null);
  assert.equal(request.account_profile_id, null);
});

test("no preset resolves catalog defaults and never chooses a named profile implicitly", () => {
  const display = launchSettingsDisplay({ ...initialDefaults(), preset: "none" }, metadata, catalog);
  assert.equal(display.model, "Agent Model");
  assert.equal(display.effort, "high");
  assert.equal(display.inheritedProfile, "No profile");
  assert.equal(display.profile, "");
  assert.equal(display.permission, "Default");
});

test("model defaults retain configured precedence, model fallback, and no effort knob", () => {
  assert.equal(catalog.defaultEffort, "high");
  assert.equal(catalog.models[0].defaultEffort, "medium");
  assert.equal(defaultEffort(catalog, "preset-model"), "high");
  assert.equal(defaultEffort({ ...catalog, defaultEffort: undefined }, "preset-model"), "low");
  assert.equal(defaultEffort(catalog, "agent-model", false), "medium");
  assert.equal(defaultEffort(catalog, "fixed"), undefined);
  assert.equal(defaultEffort(undefined, "missing"), undefined);
});

test("discovery loading and failure keep known preset values and honest unknown defaults", () => {
  const inherited = launchSettingsDisplay(initialDefaults(), metadata);
  assert.equal(inherited.model, "preset-model");
  assert.equal(inherited.effort, "low");
  const unknown = launchSettingsDisplay({ ...initialDefaults(), preset: "none" }, metadata);
  assert.equal(unknown.model, "Agent default model");
  assert.equal(unknown.effort, "Agent default effort");
  const choices = defaultsModelChoices(undefined, "", "", inherited.model);
  assert.equal(choices[0].title, "preset-model");
  assert.equal(choices[0].value, "");
  assert.equal(choices[1].value, "__default__");
});

test("profile labels and cwd resolve in the selected target context", () => {
  const targetMetadata = {
    ...metadata,
    targets: [
      {
        ...metadata.targets[0],
        defaultCwd: "/remote",
        profilesByAgent: {
          codex: [{ id: "work", label: "Remote Work" }],
        },
      },
    ],
  };
  assert.equal(launchSettingsDisplay(initialDefaults(), metadata, catalog, "/workspace").context.cwd, "/workspace");
  const remote = launchSettingsDisplay({ ...initialDefaults(), target: "box" }, targetMetadata, catalog, "/workspace");
  assert.equal(remote.inheritedProfile, "Remote Work");
  assert.equal(remote.context.cwd, "/remote");
  assert.equal(
    launchSettingsDisplay({ ...initialDefaults(), cwd: "/explicit" }, metadata, catalog).context.cwd,
    "/explicit",
  );
  assert.equal(
    launchSettingsDisplay(initialDefaults(), {
      ...metadata,
      agents: metadata.agents.map((a) => ({ ...a, profiles: [] })),
    }).inheritedProfile,
    "work",
  );
});

test("password target discovery refreshes connection state and recovers on retry", async () => {
  let connected = false;
  const calls: string[][] = [];
  const client = {
    me: async () => ({ ...metadata, targets: [{ ...metadata.targets[0], connected }] }),
    models: async (...args: [string, string, string, string]) => {
      calls.push(args);
      return catalog;
    },
  };
  const blocked = await discoverLaunchModels(client, "synthetic-token", "codex", "box", "work", true);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.catalog, undefined);
  assert.equal(calls.length, 0);
  connected = true;
  const retry = await discoverLaunchModels(client, "synthetic-token", "codex", "box", "work", true);
  assert.equal(retry.catalog, catalog);
  assert.deepEqual(calls[0].slice(1), ["codex", "box", "work", undefined]);
  connected = false;
  assert.equal((await discoverLaunchModels(client, "synthetic-token", "codex", "box", "work", true)).blocked, true);
  assert.equal(calls.length, 1);
});

test("local and key target discovery use the requested profile without a connection probe", async () => {
  const calls: string[][] = [];
  const client = {
    me: async () => {
      throw new Error("unexpected connection probe");
    },
    models: async (...args: [string, string, string, string]) => {
      calls.push(args);
      return catalog;
    },
  };
  const result = await discoverLaunchModels(client, "synthetic-token", "codex", "box", "home", false);
  assert.equal(result.catalog, catalog);
  assert.deepEqual(calls[0].slice(1), ["codex", "box", "home", undefined]);
});

test("inherited choices remain independent of explicit overrides and removed presets", () => {
  const values = {
    ...initialDefaults(),
    agent: "claude_code",
    transport: "claude_cli",
    model: "fixed",
    profile: "other",
  };
  const display = launchSettingsDisplay(values, metadata, catalog);
  assert.equal(display.agent, "Coding Agent");
  assert.equal(display.model, "Preset Model");
  assert.equal(display.profile, "other");
  assert.equal(display.defaultEffort, "Effort");
  const removed = launchSettingsDisplay({ ...initialDefaults(), preset: "removed" }, metadata, catalog);
  assert.equal(removed.model, "Agent Model");
  assert.equal(
    launchSettingsDisplay(initialDefaults(), { ...metadata, defaultPreset: undefined, presets: [] }).defaultPreset,
    "No preset · Server default",
  );
});
