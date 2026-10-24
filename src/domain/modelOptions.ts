import { ModelCatalog } from "../api/models";

export function modelEfforts(catalog: ModelCatalog | undefined, selected: string, inherited?: string): string[] {
  if (!catalog) return [];
  const model = selected === "__default__" ? catalog.defaultModel : selected || inherited || catalog.defaultModel;
  const option = catalog.models.find((entry) => entry.id === model);
  if (option) return option.efforts ?? catalog.efforts;
  return [...new Set(catalog.models.flatMap((entry) => entry.efforts ?? []))];
}
