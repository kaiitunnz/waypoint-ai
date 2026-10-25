import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseMetadata } from "../src/api/contracts";
import { parseModels } from "../src/api/models";
import { parseSession } from "../src/api/sessions";
import { parseLaunchSettings } from "../src/api/settings";
import { createRequest, initialDefaults } from "../src/domain/quickChat";
import {
  SettingsDraft,
  availability,
  capsFor,
  editableEnvKeys,
  effortChoices,
  effortForModel,
  envPatch,
  customModelValue,
  modelChoice,
  modelChoices,
  newChatDefaults,
  permissionChoices,
  planSettings,
  profileChoices,
  rebaseDraft,
  settingsBaseline,
  settingsDraft,
  settingsFingerprint,
  usageChoices,
} from "../src/domain/sessionSettings";
import { isStructured, structuredTransport } from "../src/domain/sessions";
import { launchWire, metadataWire, option, sessionRecord } from "./fixtures/settings";

const metadata = parseMetadata(metadataWire);

const setup = (session: Record<string, unknown> = {}, launch: Record<string, unknown> | null = {}) => {
  const record = parseSession(sessionRecord(session));
  const baseline = settingsBaseline(record, launch ? parseLaunchSettings(launchWire(launch)) : undefined);
  const caps = capsFor(metadata, record.backend, record.transport);
  const plan = (patch: Partial<SettingsDraft>) => {
    const draft = { ...settingsDraft(baseline), ...patch };
    return planSettings(baseline, draft, caps, availability(baseline, draft, caps, metadata, []));
  };
  return { baseline, caps, plan, draft: settingsDraft(baseline) };
};
const ops = (plan: { steps: { op: string }[] }) => plan.steps.map((step) => step.op);

test("plans Codex changes inline in the server's order", () => {
  const { plan } = setup();
  const result = plan({ usage: { kind: "plugin" }, effort: "high", model: null, permission: "plan", title: " Roses " });
  assert.deepEqual(ops(result), ["title", "permission", "model", "effort"]);
  assert.equal(result.kind, "inline");
  assert.equal(result.restartCount, 0);
  assert.deepEqual(result.steps[0].body, { title: "Roses" });
  assert.deepEqual(result.steps[2].body, { model: null });
  assert.deepEqual(result.warnings, []);
});

test("combines launch changes into one restart and explicitly clears a profile", () => {
  const { plan, draft } = setup({ status: "running" });
  const result = plan({
    profileId: null,
    args: "--fast\n --slow \n\n",
    config: "a=1",
    env: { ...draft.env, API_TOKEN: { op: "replace", value: "secret" } },
    newEnv: [{ key: " EXTRA ", value: "" }],
    effort: "high",
  });
  assert.deepEqual(ops(result), ["launch", "effort"]);
  assert.deepEqual(result.steps[0].body, {
    restart: true,
    account_profile_id: null,
    args: ["--fast", "--slow"],
    config_overrides: ["a=1"],
    env_set: { API_TOKEN: "secret", EXTRA: "" },
  });
  assert.equal(result.kind, "restart-resume");
  assert.equal(result.restartCount, 1);
  assert.equal(result.interruptsTurn, true);
  assert.deepEqual(result.warnings, [
    "The session process will restart and resume.",
    "The current turn will be interrupted.",
    "Switching account profile restarts the session under the new profile. For Codex, a thread with no persisted transcript starts fresh.",
  ]);
});

test("counts restart-only effort on Claude's native transport and every change on claude_tty", () => {
  const cli = setup({ backend: "claude_code", transport: "claude_cli" }, null).plan({ effort: "high", model: "m2" });
  assert.equal(cli.restartCount, 1);
  assert.deepEqual(
    cli.steps.map((step) => [step.op, step.restarts]),
    [
      ["model", false],
      ["effort", true],
    ],
  );
  const tty = setup({ backend: "claude_code", transport: "claude_tty", status: "waiting_input" }, null).plan({
    permission: "plan",
    model: "m2",
    effort: "high",
  });
  assert.equal(tty.restartCount, 3);
  assert.equal(tty.interruptsTurn, true);
  assert.equal(tty.warnings[0], "Applying these changes will restart the session 3 times and resume it.");
});

test("hides launch fields an agent can't restart with and explains why", () => {
  const { baseline, caps, draft } = setup(
    { backend: "opencode", transport: "opencode_http" },
    { supports_launch_settings_with_restart: false, transport_options: [] },
  );
  const available = availability(baseline, draft, caps, metadata, []);
  assert.equal(available.launch, false);
  assert.equal(available.args, false);
  assert.equal(available.profile, false);
  assert.match(available.launchNote!, /doesn't support restart-applied launch settings/);
  const plan = planSettings(baseline, { ...draft, args: "--other" }, caps, available);
  assert.equal(plan.kind, "none");
  const missing = setup({}, null);
  assert.match(
    availability(missing.baseline, missing.draft, missing.caps, metadata, []).launchNote!,
    /couldn't be loaded/,
  );
});

test("offers only native interfaces and suppresses tuning while switching", () => {
  const { baseline, caps, draft } = setup(
    { backend: "claude_code", transport: "claude_cli" },
    {
      backend: "claude_code",
      transport: "claude_cli",
      transport_options: [option("claude_cli"), option("claude_tty"), option("tmux")],
      supports_config_overrides: false,
    },
  );
  const available = availability(baseline, draft, caps, metadata, []);
  assert.deepEqual(available.transports, ["claude_cli", "claude_tty"]);
  assert.equal(available.terminalHidden, true);
  const switching = { ...draft, transport: "claude_tty", model: "other", config: "x=1" };
  const plan = planSettings(baseline, switching, caps, availability(baseline, switching, caps, metadata, []));
  assert.deepEqual(ops(plan), ["launch"]);
  assert.deepEqual(plan.steps[0].body, { restart: true, transport: "claude_tty", config_overrides: ["x=1"] });
  assert.equal(plan.warnings[0], "The session will be restarted, keeping its conversation.");
  assert.match(availability(baseline, switching, caps, metadata, []).tuningNote!, /interface change first/);
});

test("treats terminal transports as browser-only sessions", () => {
  assert.equal(isStructured(parseSession(sessionRecord({ transport: "tmux" })), metadata), false);
  assert.equal(isStructured(parseSession(sessionRecord({ transport: "claude_tty" })), metadata), true);
});

test("protects runtime and profile-owned environment keys", () => {
  const { baseline, draft } = setup();
  assert.deepEqual(editableEnvKeys(baseline, draft), ["API_TOKEN"]);
  const cleared = { ...draft, profileId: null };
  const unprotected = setup({}, { protected_launch_env_keys: ["WAYPOINT_SESSION_ID"], account_profile_id: null });
  assert.deepEqual(editableEnvKeys(unprotected.baseline, unprotected.draft), ["API_TOKEN", "CODEX_HOME"]);
  assert.deepEqual(editableEnvKeys(unprotected.baseline, { ...unprotected.draft, profileId: "work" }), ["API_TOKEN"]);
  const patch = envPatch(baseline, {
    ...cleared,
    env: {
      API_TOKEN: { op: "replace", value: "" },
      WAYPOINT_SESSION_ID: { op: "remove", value: "" },
      CODEX_HOME: { op: "remove", value: "" },
    },
    newEnv: [
      { key: "WAYPOINT_SESSION_ID", value: "x" },
      { key: "API_TOKEN", value: "x" },
      { key: "A=B", value: "x" },
      { key: "NEW", value: "1" },
      { key: "NEW", value: "2" },
      { key: "  ", value: "ignored" },
    ],
  });
  assert.deepEqual(patch.set, { NEW: "1" });
  assert.deepEqual(patch.unset, []);
  assert.deepEqual(patch.errors, [
    "WAYPOINT_SESSION_ID is managed by Waypoint.",
    "API_TOKEN is already set. Replace it instead.",
    "A=B isn't a valid variable name.",
    "NEW is listed twice.",
  ]);
});

test("model and effort choices keep defaults, custom values, and the effort's three states", () => {
  const catalog = parseModels({
    default_model_id: "a",
    default_model_label: "Model A",
    effort_levels: ["low", "high"],
    models: [
      { id: "a", label: "Model A", supported_efforts: ["low", "medium"] },
      { id: "b", label: "Model B", supported_efforts: null },
      { id: "c", label: "Model C", supported_efforts: [] },
    ],
  });
  const { baseline, draft } = setup({ model: "custom-x", effort: "turbo" });
  assert.deepEqual(
    modelChoices(catalog, baseline, draft).map((choice) => choice.title),
    ["Default (Model A)", "Custom · custom-x", "Model A", "Model B", "Model C"],
  );
  for (const typed of ["t", "typed", "typed-model"]) {
    const typing = { ...draft, model: typed };
    assert.equal(modelChoice(catalog, baseline, typing), customModelValue);
    assert.ok(modelChoices(catalog, baseline, typing).some((choice) => choice.value === customModelValue));
  }
  assert.equal(modelChoice(catalog, baseline, { ...draft, model: "b" }), "b");
  const free = { ...catalog, freeText: true };
  assert.ok(modelChoices(free, baseline, { ...draft, model: "b" }).some((choice) => choice.value === customModelValue));
  assert.equal(modelChoice(catalog, baseline, { ...draft, model: null }), "__default__");
  assert.deepEqual(effortChoices(catalog, baseline, { ...draft, model: null }).efforts, ["low", "medium"]);
  assert.deepEqual(effortChoices(catalog, baseline, { ...draft, model: "b" }).efforts, ["low", "high"]);
  assert.deepEqual(effortChoices(catalog, baseline, { ...draft, model: "c" }).efforts, []);
  assert.ok(effortChoices(catalog, baseline, { ...draft, model: "c" }).choices.some((c) => c.value === "turbo"));
  assert.equal(effortForModel(catalog, "a", "high"), null);
  assert.equal(effortForModel(catalog, "b", "high"), "high");
});

test("dropdown choices always include the current value so nothing changes on open", () => {
  const unset = setup(
    { permission_mode: null, account_profile_id: "gone", account_profile_label: "Old" },
    { account_profile_id: "gone" },
  );
  assert.equal(permissionChoices(unset.caps, unset.baseline)[0].title, "Not set");
  assert.ok(profileChoices(unset.baseline).some((choice) => choice.title === "Unavailable · Old"));
  const usage = setup({
    usage_limit_source: "usage_provider",
    usage_provider_id: "p",
    usage_provider_account_key: "k",
  });
  assert.ok(usageChoices([], usage.baseline).some((choice) => choice.title === "Unavailable · p"));
  for (const { plan } of [unset, usage]) assert.equal(plan({}).kind, "none");
});

test("blocks invalid input and launch changes while starting, and gates tuning on exited sessions", () => {
  assert.deepEqual(setup().plan({ title: "  " }).errors, ["Enter a title."]);
  const starting = setup({ status: "starting" });
  assert.match(starting.plan({ args: "--x" }).errors[0], /still starting/);
  assert.deepEqual(ops(starting.plan({ model: "other" })), []);
  assert.match(availability(starting.baseline, starting.draft, starting.caps, metadata, []).tuningNote!, /starting/);
  const exited = setup({ status: "exited" });
  const available = availability(exited.baseline, exited.draft, exited.caps, metadata, []);
  assert.equal(available.model, false);
  assert.match(available.tuningNote!, /Reattach/);
  const plan = exited.plan({ model: "other", args: "--x" });
  assert.deepEqual(ops(plan), ["launch"]);
  assert.equal(plan.warnings[0], "Applying these changes starts the session again.");
});

test("agent, target, or folder changes become a new chat", () => {
  const { plan } = setup();
  const result = plan({ cwd: "/work/other", title: "Ignored" });
  assert.equal(result.kind, "new-chat");
  assert.deepEqual(result.steps, []);
  assert.deepEqual(plan({ cwd: " " }).errors, ["Enter a working directory for the new chat."]);
});

test("new chat defaults keep agent-default meanings and only supported lists", () => {
  const codex = setup({ model: null, effort: null, account_profile_id: null }, { account_profile_id: null });
  const same = newChatDefaults(initialDefaults(), codex.baseline, { ...codex.draft, cwd: "/elsewhere" }, metadata);
  assert.equal(same.cwd, "/elsewhere");
  assert.equal(same.model, "__default__");
  assert.equal(same.effort, "__default__");
  assert.equal(same.profile, "__default__");
  assert.equal(same.permission, "default");
  assert.deepEqual(same.args, ["--fast"]);
  assert.equal(same.config, undefined);
  const request = createRequest(same, metadata, "install", "op");
  assert.equal(request.model, null);
  assert.equal(request.cwd, "/elsewhere");

  const claude = setup(
    { backend: "claude_code", transport: "claude_cli", args: [], permission_mode: null },
    { backend: "claude_code", transport: "claude_cli", args: [], supports_config_overrides: false },
  );
  const claudeDefaults = newChatDefaults(initialDefaults(), claude.baseline, { ...claude.draft, cwd: "/x" }, metadata);
  assert.equal(claudeDefaults.config, undefined);
  assert.equal(claudeDefaults.args, undefined);
  assert.equal(claudeDefaults.permission, "");
  assert.doesNotThrow(() => createRequest(claudeDefaults, metadata, "install", "op"));

  const unknown = setup({}, null);
  assert.equal(
    newChatDefaults(initialDefaults(), unknown.baseline, { ...unknown.draft, cwd: "/y" }, metadata).args,
    undefined,
  );

  const moved = newChatDefaults(initialDefaults(), codex.baseline, { ...codex.draft, targetId: "box" }, metadata);
  assert.equal(moved.target, "box");
  assert.equal(moved.model, "");
  assert.equal(moved.args, undefined);
});

test("rebases by step so applied environment changes are not sent again", () => {
  const { baseline, draft } = setup();
  const edited: SettingsDraft = {
    ...draft,
    title: "Mine",
    model: "other",
    env: { ...draft.env, API_TOKEN: { op: "replace", value: "secret" } },
    newEnv: [{ key: "EXTRA", value: "1" }],
  };
  const next = settingsBaseline(
    parseSession(sessionRecord({ title: "Mine" })),
    parseLaunchSettings(launchWire({ launch_env_keys: ["API_TOKEN", "EXTRA", "WAYPOINT_SESSION_ID"] })),
  );
  const rebased = rebaseDraft(edited, baseline, next, ["title", "launch"]);
  assert.equal(rebased.model, "other");
  assert.deepEqual(rebased.newEnv, []);
  assert.equal(rebased.env.API_TOKEN.op, "keep");
  const caps = capsFor(metadata, "codex", "codex_app_server");
  const plan = planSettings(next, rebased, caps, availability(next, rebased, caps, metadata, []));
  assert.deepEqual(ops(plan), ["model"]);
  assert.equal(plan.restartCount, 0);

  const uncertain = rebaseDraft(edited, baseline, next, [], true);
  assert.equal(uncertain.env.API_TOKEN.op, "keep");
  assert.deepEqual(uncertain.newEnv, []);
  assert.equal(uncertain.title, "Mine");
});

test("rebasing follows the server for untouched fields and keeps the user's edits", () => {
  const { baseline, draft } = setup();
  const next = settingsBaseline(parseSession(sessionRecord({ title: "Renamed elsewhere", effort: "high" })));
  const rebased = rebaseDraft({ ...draft, model: "mine" }, baseline, next);
  assert.equal(rebased.title, "Renamed elsewhere");
  assert.equal(rebased.effort, "high");
  assert.equal(rebased.model, "mine");
});

test("the fingerprint ignores status but sees settings and capability changes", () => {
  const a = setup();
  const running = setup({ status: "running" });
  assert.equal(settingsFingerprint(a.baseline, a.caps), settingsFingerprint(running.baseline, running.caps));
  const renamed = setup({ title: "Other" });
  assert.notEqual(settingsFingerprint(a.baseline, a.caps), settingsFingerprint(renamed.baseline, renamed.caps));
  const keys = setup({}, { launch_env_keys: ["API_TOKEN", "NEW"] });
  assert.notEqual(settingsFingerprint(a.baseline, a.caps), settingsFingerprint(keys.baseline, keys.caps));
  assert.notEqual(
    settingsFingerprint(a.baseline, a.caps),
    settingsFingerprint(a.baseline, a.caps && { ...a.caps, interruptsTurn: true }),
  );
});

test("Waypoint's own catalog drives restart disclosure per agent and interface", () => {
  const backends = JSON.parse(readFileSync("tests/fixtures/waypointBackends.json", "utf8"));
  const real = parseMetadata({ authenticated: true, default_backend: "codex", backends });
  const plan = (backend: string, transport: string, status: string, patch: Partial<SettingsDraft>) => {
    const baseline = settingsBaseline(
      parseSession(sessionRecord({ backend, transport, status, permission_mode: "default" })),
    );
    const caps = capsFor(real, backend, transport);
    const draft = { ...settingsDraft(baseline), ...patch };
    return planSettings(baseline, draft, caps, availability(baseline, draft, caps, real, []));
  };
  const codex = plan("codex", "codex_app_server", "running", { effort: "medium", model: "m", permission: "plan" });
  assert.deepEqual([codex.kind, codex.restartCount, codex.interruptsTurn], ["inline", 0, false]);
  const claude = plan("claude_code", "claude_cli", "idle", { effort: "medium", model: "m", permission: "plan" });
  assert.deepEqual([claude.kind, claude.restartCount], ["restart-resume", 1]);
  assert.deepEqual(
    claude.steps.filter((step) => step.restarts).map((step) => step.op),
    ["effort"],
  );
  const tty = plan("claude_code", "claude_tty", "running", { effort: "medium", permission: "plan" });
  assert.deepEqual([tty.restartCount, tty.interruptsTurn], [2, true]);
  assert.equal(structuredTransport(real, "tmux"), false);
  assert.ok(
    ["claude_cli", "claude_tty", "codex_app_server", "opencode_http"].every((t) => structuredTransport(real, t)),
  );
});
