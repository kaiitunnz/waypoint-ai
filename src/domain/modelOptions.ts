import { ModelCatalog } from "../api/models";

export function modelEfforts(catalog: ModelCatalog | undefined, selected: string, inherited?: string): string[] {
  if (!catalog) return [];
  const model = selected === "__default__" ? catalog.defaultModel : selected || inherited || catalog.defaultModel;
  const option = catalog.models.find((entry) => entry.id === model);
  if (option) return option.efforts ?? catalog.efforts;
  return [...new Set(catalog.models.flatMap((entry) => entry.efforts ?? []))];
}

// A model typed in a Custom Model field keeps this one dropdown value while it changes; a dropdown whose value briefly
// matches no item falls back to its first item and would reset the model mid-typing.
export const customModelValue = "__custom__";

// Quick Chat Defaults' model dropdown value: "" inherits and "__default__" is the agent default.
export function defaultsModelChoice(catalog: ModelCatalog | undefined, model: string): string {
  return !model || model === "__default__" || catalog?.models.some((entry) => entry.id === model)
    ? model
    : customModelValue;
}
