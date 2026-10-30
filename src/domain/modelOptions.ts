import { ModelCatalog } from "../api/models";

export function modelLabel(catalog: ModelCatalog | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return (
    catalog?.models.find((entry) => entry.id === id)?.label ??
    (id === catalog?.defaultModel ? catalog.defaultLabel : undefined) ??
    id
  );
}

export function defaultModelLabel(catalog: ModelCatalog | undefined): string | undefined {
  return catalog?.defaultLabel || modelLabel(catalog, catalog?.defaultModel);
}

// New launches pass the configured effort to the agent before its own model default can apply.
export function defaultEffort(catalog: ModelCatalog | undefined, model?: string, launch = true): string | undefined {
  const option = catalog?.models.find((entry) => entry.id === (model || catalog.defaultModel));
  if (option?.efforts?.length === 0) return undefined;
  return (launch ? catalog?.defaultEffort : undefined) || option?.defaultEffort;
}

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

// Quick Chat Defaults' model dropdown value: "" inherits and "__default__" is the agent default. The saved model keeps
// its own value, so loading the catalog never changes the selection.
export function defaultsModelChoice(catalog: ModelCatalog | undefined, model: string, saved: string): string {
  return !model || model === "__default__" || model === saved || catalog?.models.some((entry) => entry.id === model)
    ? model
    : customModelValue;
}

// Every list includes the current value, so a controlled dropdown never falls back to its first item. The saved model
// gets its own item only while selected, so a reset to another agent or target doesn't keep offering it.
export function defaultsModelChoices(
  catalog: ModelCatalog | undefined,
  model: string,
  saved: string,
  inherited?: string,
): { value: string; title: string }[] {
  const choice = defaultsModelChoice(catalog, model, saved);
  const listed = (id: string) => !!catalog?.models.some((entry) => entry.id === id);
  const choices = [
    { value: "", title: inherited || defaultModelLabel(catalog) || "Agent default model" },
    { value: "__default__", title: `${defaultModelLabel(catalog) || "Model"} · Agent default` },
  ];
  if (model && model === saved && model !== "__default__" && !listed(model))
    choices.push({ value: model, title: catalog ? `Custom · ${model}` : model });
  if (choice === customModelValue || catalog?.freeText)
    choices.push({
      value: customModelValue,
      title: choice === customModelValue ? `Custom · ${model}` : "Custom model (type below)",
    });
  for (const entry of catalog?.models ?? []) choices.push({ value: entry.id, title: entry.label });
  return choices;
}
