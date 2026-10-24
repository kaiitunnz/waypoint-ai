import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModels } from "../src/api/models";
import { modelEfforts } from "../src/domain/modelOptions";

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
