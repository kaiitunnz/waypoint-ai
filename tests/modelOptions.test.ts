import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModels } from "../src/api/models";
import { customModelValue, defaultsModelChoice, defaultsModelChoices, modelEfforts } from "../src/domain/modelOptions";

test("effort choices resolve inherited and agent-default models like the frontend", () => {
  const catalog = parseModels({
    default_model_id: "default",
    effort_levels: ["low", "high"],
    models: [
      { id: "default", label: "Default", supported_efforts: ["medium", "high"] },
      { id: "preset", label: "Preset", supported_efforts: ["low"] },
      { id: "unknown", label: "Unknown", supported_efforts: null },
      { id: "fixed", label: "Fixed", supported_efforts: [] },
    ],
  });
  assert.deepEqual(modelEfforts(catalog, ""), ["medium", "high"]);
  assert.deepEqual(modelEfforts(catalog, "", "preset"), ["low"]);
  assert.deepEqual(modelEfforts(catalog, "__default__", "preset"), ["medium", "high"]);
  assert.deepEqual(modelEfforts(catalog, "unknown"), ["low", "high"]);
  assert.deepEqual(modelEfforts(catalog, "fixed"), []);
  assert.deepEqual(modelEfforts(undefined, ""), []);
  assert.deepEqual(modelEfforts({ ...catalog, defaultModel: undefined }, ""), ["medium", "high", "low"]);
});

test("a model typed into Quick Chat Defaults keeps one dropdown value while it changes", () => {
  const catalog = {
    models: [{ id: "gpt-5", label: "GPT-5" }],
    freeText: true,
    efforts: [],
  };
  assert.equal(defaultsModelChoice(catalog, "", ""), "");
  assert.equal(defaultsModelChoice(catalog, "__default__", ""), "__default__");
  assert.equal(defaultsModelChoice(catalog, "gpt-5", ""), "gpt-5");
  for (const typed of ["g", "gpt-5-m", "gpt-5-mini"])
    assert.equal(defaultsModelChoice(catalog, typed, ""), customModelValue);
  // A saved model keeps its own value whether or not the catalog has loaded or lists it.
  for (const loaded of [undefined, catalog]) {
    assert.equal(defaultsModelChoice(loaded, "gpt-5", "gpt-5"), "gpt-5");
    assert.equal(defaultsModelChoice(loaded, "saved-model", "saved-model"), "saved-model");
  }
  assert.equal(defaultsModelChoice(undefined, "typed", "saved-model"), customModelValue);
});

test("Quick Chat Defaults' model list always holds the current choice and drops a saved model after a reset", () => {
  const catalog = { models: [{ id: "gpt-5", label: "GPT-5" }], freeText: true, efforts: [] };
  const values = (loaded: typeof catalog | undefined, model: string, saved: string) =>
    defaultsModelChoices(loaded, model, saved).map((choice) => choice.value);
  const cases: [typeof catalog | undefined, string, string][] = [
    [undefined, "gpt-5", "gpt-5"],
    [catalog, "gpt-5", "gpt-5"],
    [undefined, "saved-model", "saved-model"],
    [catalog, "saved-model", "saved-model"],
    [catalog, "gpt-5", ""],
    [catalog, "gpt-5-mini", ""],
    [catalog, "", "saved-model"],
  ];
  for (const [loaded, model, saved] of cases) {
    const list = values(loaded, model, saved);
    assert.ok(list.includes(defaultsModelChoice(loaded, model, saved)), `${model} is missing`);
    assert.equal(new Set(list).size, list.length, `${model} has duplicate values`);
  }
  assert.ok(!values(catalog, "", "saved-model").includes("saved-model"));
  assert.deepEqual(
    defaultsModelChoices(catalog, "saved-model", "saved-model").find((choice) => choice.value === "saved-model")?.title,
    "Custom · saved-model",
  );
});
