import {
  Action,
  ActionPanel,
  Alert,
  Form,
  Icon,
  Keyboard,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  EnvRow,
  SettingsDraft,
  SettingsPlan,
  availability,
  contextLine,
  editableEnvKeys,
  effortChoices,
  effortForModel,
  fromChoice,
  modelChoice,
  modelChoices,
  permissionChoices,
  profileChoices,
  rebaseDraft,
  removeLastEnvRow,
  settingsDraft,
  toChoice,
  usageChoices,
  usageFromValue,
  usageValue,
  withBlankEnvRow,
} from "../domain/sessionSettings";
import { customModelValue } from "../domain/modelOptions";
import { interfaceName } from "../domain/sessions";
import { FeedConnection } from "../hooks/sessionFeeds";
import { SessionSettingsController } from "../hooks/sessionSettingsController";
import { ConnectTarget } from "./ConnectTarget";

function planText(plan: SettingsPlan | undefined): string {
  if (!plan) return "";
  if (plan.kind === "none") return "No changes yet.";
  const labels = plan.steps.map((step) => step.label).join(", ");
  return [plan.kind === "inline" ? `Applies now: ${labels}.` : `Applies ${labels}.`, ...plan.warnings].join("\n");
}

export function SessionSettings({
  connection,
  sessionId,
  onApplied,
}: {
  connection: FeedConnection;
  sessionId: string;
  onApplied?: () => void;
}) {
  // Callers rebuild the connection object on every render, so the controller is created once per form.
  const [controller] = useState(() => new SessionSettingsController(connection, sessionId));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [draft, setDraft] = useState<SettingsDraft>();
  const [problem, setProblem] = useState<string>();
  const [effortReset, setEffortReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const { pop } = useNavigation();
  const mounted = useRef(true);
  // The trailing blank variable row, which is always the last one.
  const blankKey = useRef<Form.TextField>(null);
  // The effort last chosen in the form; a custom model typed through a listed ID mustn't drop it for good.
  const effortIntent = useRef<string | null | undefined>(undefined);
  const { baseline, metadata, caps } = state;
  const replaceDraft = (next: SettingsDraft) => {
    effortIntent.current = undefined;
    setDraft(next);
  };
  useEffect(() => {
    mounted.current = true;
    controller.attach();
    void controller.load().then((loaded) => loaded && replaceDraft(settingsDraft(loaded)));
    return () => {
      mounted.current = false;
      controller.stop();
    };
  }, [controller]);
  const profileId = draft?.profileId;
  useEffect(() => {
    if (baseline && profileId !== undefined) void controller.loadModels(profileId);
  }, [controller, baseline?.sessionId, profileId]);

  if (!baseline || !metadata || !draft)
    return (
      <Form
        navigationTitle="Change Session Settings"
        isLoading={state.loading}
        actions={
          state.error ? (
            <ActionPanel>
              <Action
                title="Reload Settings"
                icon={Icon.ArrowClockwise}
                onAction={() => void controller.load().then((loaded) => loaded && replaceDraft(settingsDraft(loaded)))}
              />
            </ActionPanel>
          ) : undefined
        }
      >
        {state.error && <Form.Description title="Not loaded" text={state.error} />}
      </Form>
    );

  const available = availability(baseline, draft, caps, metadata, state.providers);
  const plan = controller.plan(draft);
  const efforts = effortChoices(state.catalog, baseline, draft);
  const working = busy || state.applying;
  const connectTarget = state.connectTarget;
  const target = metadata.targets.find((entry) => entry.id === connectTarget);
  const reattachable =
    state.reattach ||
    (["exited", "error"].includes(baseline.status) &&
      metadata.agents.find((agent) => agent.nativeTransport === baseline.transport)?.reattach === true);
  const setModel = (model: string | null) => {
    if (model === draft.model) return;
    if (effortIntent.current === undefined) effortIntent.current = draft.effort;
    const effort = effortForModel(state.catalog, model, effortIntent.current);
    setEffortReset(effort !== effortIntent.current);
    update({ model, effort });
  };
  const update = (patch: Partial<SettingsDraft>) => {
    setProblem(undefined);
    setDraft((current) => current && { ...current, ...patch });
  };
  const updateRows = (change: (rows: EnvRow[]) => EnvRow[]) => {
    setProblem(undefined);
    setDraft((current) => current && { ...current, newEnv: change(current.newEnv) });
  };
  const updateRow = (index: number, patch: Partial<EnvRow>) =>
    updateRows((rows) => withBlankEnvRow(rows.map((row, i) => (i === index ? { ...row, ...patch } : row))));

  async function submit() {
    if (!draft || !plan || working) return;
    if (plan.errors.length) return setProblem(plan.errors[0]);
    if (plan.kind === "none") return setProblem("Change a setting first.");
    setBusy(true);
    try {
      const prepared = await controller.prepare(draft, plan);
      if (prepared.status !== "ready") {
        replaceDraft(prepared.draft);
        return setProblem(prepared.message);
      }
      const restart = prepared.plan.restartCount > 0 || prepared.plan.interruptsTurn;
      if (
        restart &&
        !(await confirmAlert({
          title: "Restart this session?",
          message: prepared.plan.warnings.join("\n"),
          primaryAction: { title: "Apply and Restart", style: Alert.ActionStyle.Destructive },
        }))
      )
        return;
      const result = await controller.apply(draft, prepared.plan);
      if (result.status !== "reconfirm") onApplied?.();
      // Restarts can outlast the form; once it's closed, the outcome is reported by toast instead.
      if (result.status === "reconfirm") {
        const message =
          result.plan.errors[0] ??
          "The session changed while you were confirming. Review the updated plan and apply again.";
        if (mounted.current) return setProblem(message);
        await showToast({ style: Toast.Style.Failure, title: "Changes not applied", message });
        return;
      }
      if (result.status === "failed") {
        if (mounted.current) return replaceDraft(result.draft);
        await showToast({
          style: Toast.Style.Failure,
          title: result.applied.length ? "Some changes weren't applied" : "Changes not applied",
          message: `${result.applied.length ? `Applied: ${result.applied.join(", ")}. ` : ""}${result.message}`,
        });
        return;
      }
      await showToast({
        style: Toast.Style.Success,
        title: result.plan.restartCount > 0 ? "Session restarted with new settings" : "Changes applied",
      });
      if (mounted.current) pop();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not apply the changes.";
      if (mounted.current) setProblem(message);
      else await showToast({ style: Toast.Style.Failure, title: "Changes not applied", message });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function reload() {
    const previous = baseline!;
    const next = await controller.load();
    if (next) {
      effortIntent.current = undefined;
      setDraft((current) => current && rebaseDraft(current, previous, next));
    }
  }

  const submitTitle = plan?.kind === "restart-resume" ? "Apply and Restart" : "Apply Changes";
  const result = state.result;
  return (
    <Form
      navigationTitle="Change Session Settings"
      isLoading={state.loading || working}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={submitTitle} icon={Icon.Checkmark} onSubmit={submit} />
          {connectTarget && (
            <Action.Push
              title="Connect SSH Target"
              icon={Icon.Lock}
              target={
                <ConnectTarget
                  target={target}
                  connect={async (password) => {
                    const result = await controller.connectTarget(connectTarget, password);
                    if (result.connected && mounted.current) setProblem(undefined);
                    return result;
                  }}
                />
              }
            />
          )}
          {reattachable && !working && (
            <Action title="Reattach Session" icon={Icon.Link} onAction={() => controller.reattach()} />
          )}
          {available.launch && (
            <Action
              title="Add Environment Variable"
              icon={Icon.Plus}
              shortcut={Keyboard.Shortcut.Common.New}
              onAction={() => blankKey.current?.focus()}
            />
          )}
          {available.launch && draft.newEnv.length > 1 && (
            <Action title="Remove New Variable" icon={Icon.Minus} onAction={() => updateRows(removeLastEnvRow)} />
          )}
          <Action
            title="Reload Settings"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={reload}
          />
        </ActionPanel>
      }
    >
      <Form.Description text={contextLine(baseline, metadata)} />
      <Form.Description
        title={plan?.kind === "restart-resume" ? "Restart" : "Changes"}
        text={state.restarting ? "Restarting session…" : planText(plan)}
      />
      {(problem || plan?.errors.length) && <Form.Description title="Check" text={problem ?? plan!.errors.join("\n")} />}
      {result && (
        <Form.Description
          title={result.applied.length ? "Partly applied" : "Not applied"}
          text={`${result.applied.length ? `Applied: ${result.applied.join(", ")}.\n` : ""}${result.message}`}
        />
      )}
      {state.error && <Form.Description title="Not reloaded" text={state.error} />}
      {state.notices.length > 0 && <Form.Description title="Note" text={state.notices.join("\n")} />}
      {available.transports.length > 0 && (
        <Form.Dropdown
          id="transport"
          title="Interface"
          value={draft.transport}
          info={available.terminalHidden ? "Terminal interfaces are available in Waypoint." : undefined}
          onChange={(transport) => update({ transport })}
        >
          {available.transports.map((transport) => (
            <Form.Dropdown.Item key={transport} value={transport} title={interfaceName(metadata, transport)} />
          ))}
        </Form.Dropdown>
      )}
      {available.launch && !available.transports.length && available.terminalHidden && (
        <Form.Description
          title="Interface"
          text={`${interfaceName(metadata, baseline.transport)}. Terminal interfaces are available in Waypoint.`}
        />
      )}
      {available.profile && (
        <Form.Dropdown
          id="profile"
          title="Account Profile"
          value={toChoice(draft.profileId)}
          onChange={(value) => update({ profileId: fromChoice(value) })}
        >
          {profileChoices(baseline).map((choice) => (
            <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
          ))}
        </Form.Dropdown>
      )}
      <Form.TextField id="title" title="Title" value={draft.title} onChange={(title) => update({ title })} />
      <Form.Separator />
      {available.tuningNote && <Form.Description title="Model" text={available.tuningNote} />}
      {available.permission && (
        <Form.Dropdown
          id="permission"
          title="Permission Mode"
          value={toChoice(draft.permission)}
          onChange={(value) => update({ permission: fromChoice(value) })}
        >
          {permissionChoices(caps, baseline).map((choice) => (
            <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
          ))}
        </Form.Dropdown>
      )}
      {available.model && (
        <Form.Dropdown
          id="model"
          title="Model"
          value={modelChoice(state.catalog, baseline, draft)}
          onChange={(value) => {
            if (value !== customModelValue) setModel(fromChoice(value));
          }}
        >
          {modelChoices(state.catalog, baseline, draft).map((choice) => (
            <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
          ))}
        </Form.Dropdown>
      )}
      {available.model && state.catalog?.freeText && (
        <Form.TextField
          id="customModel"
          title="Custom Model"
          placeholder="Optional model ID"
          value={draft.model ?? ""}
          onChange={(value) => setModel(value.trim() ? value.trim() : null)}
        />
      )}
      {available.effort && (efforts.efforts.length > 0 || baseline.effort !== null) && (
        <Form.Dropdown
          id="effort"
          title="Effort"
          value={toChoice(draft.effort)}
          info={
            effortReset ? "Reset to the default because the new model doesn't offer the earlier effort." : undefined
          }
          onChange={(value) => {
            setEffortReset(false);
            effortIntent.current = fromChoice(value);
            update({ effort: fromChoice(value) });
          }}
        >
          {efforts.choices.map((choice) => (
            <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
          ))}
        </Form.Dropdown>
      )}
      <Form.Separator />
      <Form.Description
        title="Advanced"
        text={available.launchNote ?? "Launch changes restart the session and keep its conversation."}
      />
      {available.usage && (
        <Form.Dropdown
          id="usage"
          title="Usage Source"
          value={usageValue(draft.usage)}
          onChange={(value) => update({ usage: usageFromValue(value) })}
        >
          {usageChoices(state.providers, baseline).map((choice) => (
            <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
          ))}
        </Form.Dropdown>
      )}
      {available.args && (
        <Form.TextArea
          id="args"
          title="Custom Arguments"
          placeholder="One argument per line"
          value={draft.args}
          onChange={(args) => update({ args })}
        />
      )}
      {available.config && (
        <Form.TextArea
          id="config"
          title="Config Overrides"
          placeholder="One override per line"
          value={draft.config}
          onChange={(config) => update({ config })}
        />
      )}
      {available.launch &&
        editableEnvKeys(baseline, draft).map((key) => {
          const entry = draft.env[key] ?? { op: "keep", value: "" };
          return [
            <Form.Dropdown
              key={`op-${key}`}
              id={`env-op-${key}`}
              title={key}
              value={entry.op}
              onChange={(op) => update({ env: { ...draft.env, [key]: { ...entry, op: op as typeof entry.op } } })}
            >
              <Form.Dropdown.Item value="keep" title="Keep stored value" />
              <Form.Dropdown.Item value="replace" title="Replace" />
              <Form.Dropdown.Item value="remove" title="Remove" />
            </Form.Dropdown>,
            entry.op === "replace" && (
              <Form.PasswordField
                key={`value-${key}`}
                id={`env-value-${key}`}
                title=""
                placeholder="New value"
                value={entry.value}
                onChange={(value) => update({ env: { ...draft.env, [key]: { op: "replace", value } } })}
              />
            ),
          ];
        })}
      {available.launch &&
        draft.newEnv.map((row, index) => [
          <Form.TextField
            key={`new-key-${index}`}
            id={`new-key-${index}`}
            ref={index === draft.newEnv.length - 1 ? blankKey : undefined}
            title="New Variable"
            placeholder="NAME"
            value={row.key}
            onChange={(key) => updateRow(index, { key })}
          />,
          <Form.PasswordField
            key={`new-value-${index}`}
            id={`new-value-${index}`}
            title=""
            placeholder="Value"
            value={row.value}
            onChange={(value) => updateRow(index, { value })}
          />,
        ])}
    </Form>
  );
}
