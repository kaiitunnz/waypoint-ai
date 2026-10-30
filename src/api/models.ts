import { isRecord } from "../domain/connections";
export interface ModelCatalog {
  models: { id: string; label: string; efforts?: string[]; defaultEffort?: string }[];
  defaultModel?: string;
  defaultLabel?: string;
  defaultEffort?: string;
  freeText: boolean;
  efforts: string[];
}
export function parseModels(value: unknown): ModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error("Invalid model catalog");
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    models: value.models.map((model) => {
      if (!isRecord(model) || typeof model.id !== "string" || typeof model.label !== "string")
        throw new Error("Invalid model");
      return {
        id: model.id,
        label: model.label,
        efforts: model.supported_efforts == null ? undefined : strings(model.supported_efforts),
        defaultEffort: typeof model.default_effort === "string" ? model.default_effort : undefined,
      };
    }),
    defaultModel: typeof value.default_model_id === "string" ? value.default_model_id : undefined,
    defaultLabel: typeof value.default_model_label === "string" ? value.default_model_label : undefined,
    defaultEffort: typeof value.default_effort === "string" ? value.default_effort : undefined,
    freeText: value.supports_free_text === true,
    efforts: strings(value.effort_levels),
  };
}
