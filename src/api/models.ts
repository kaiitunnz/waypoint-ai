import { isRecord } from "../domain/connections";
export interface ModelCatalog {
  models: { id: string; label: string; efforts?: string[] }[];
  defaultModel?: string;
  defaultLabel?: string;
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
      };
    }),
    defaultModel: typeof value.default_model_id === "string" ? value.default_model_id : undefined,
    defaultLabel: typeof value.default_model_label === "string" ? value.default_model_label : undefined,
    freeText: value.supports_free_text === true,
    efforts: strings(value.effort_levels),
  };
}
