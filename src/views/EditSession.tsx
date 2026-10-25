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
import { ChatDefaults, createRequest } from "../domain/quickChat";
import {
  SettingsDraft,
  SettingsPlan,
  availability,
  editableEnvKeys,
  effortChoices,
  effortForModel,
  fromChoice,
  customModelValue,
  modelChoice,
  modelChoices,
  newChatDefaults,
  permissionChoices,
  profileChoices,
  rebaseDraft,
  settingsDraft,
  toChoice,
  usageChoices,
  usageFromValue,
  usageValue,
} from "../domain/sessionSettings";
import { structuredTransport } from "../domain/sessions";
import { FeedConnection } from "../hooks/sessionFeeds";
import { SessionSettingsController } from "../hooks/sessionSettingsController";
import { ConnectTarget } from "./ConnectTarget";

// Saves Quick Chat defaults built from the current ones; returns a view to open when the chat isn't already on screen.
export interface NewChatOption {
  start: (build: (current: ChatDefaults) => ChatDefaults) => Promise<React.ReactElement | void>;
  // Opens the returned view in place of the editor, letting the conversation underneath pause.
  open?: (view: React.ReactElement) => void;
}

function planText(plan: SettingsPlan | undefined): string {
  if (!plan) return "";
  if (plan.kind === "none") return "No changes yet.";
  if (plan.kind === "new-chat") return plan.warnings.join("\n");
  const labels = plan.steps.map((step) => step.label).join(", ");
  return [plan.kind === "inline" ? `Applies now: ${labels}.` : `Applies ${labels}.`, ...plan.warnings].join("\n");
}

export function EditSession({
  connection,
  sessionId,
  newChat,
  onApplied,
}: {
  connection: FeedConnection;
  sessionId: string;
  newChat?: NewChatOption;
  onApplied?: () => void;
}) {
  // Callers rebuild the connection object on every render, so the controller is created once per form.
  const [controller] = useState(() => new SessionSettingsController(connection, sessionId));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [draft, setDraft] = useState<SettingsDraft>();
  const [problem, setProblem] = useState<string>();
  const [effortReset, setEffortReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const { pop, push } = useNavigation();
  const mounted = useRef(true);
  const { baseline, metadata, caps } = state;
  useEffect(() => {
    mounted.current = true;
    controller.attach();
    void controller.load().then((loaded) => loaded && setDraft(settingsDraft(loaded)));
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
        navigationTitle="Edit Current Session"
        isLoading={state.loading}
        actions={
          state.error ? (
            <ActionPanel>
              <Action
                title="Reload Settings"
                icon={Icon.ArrowClockwise}
                onAction={() => void controller.load().then((loaded) => loaded && setDraft(settingsDraft(loaded)))}
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
  const target = metadata.targets.find((entry) => entry.id === state.connectTarget);
  const reattachable =
    state.reattach ||
    (["exited", "error"].includes(baseline.status) &&
      metadata.agents.find((agent) => agent.nativeTransport === baseline.transport)?.reattach === true);
  const setModel = (model: string | null) => {
    if (model === draft.model) return;
    const effort = effortForModel(state.catalog, model, draft.effort);
    setEffortReset(effort !== draft.effort);
    update({ model, effort });
  };
  const update = (patch: Partial<SettingsDraft>) => {
    setProblem(undefined);
    setDraft((current) => current && { ...current, ...patch });
  };

  async function submit() {
    if (!draft || !plan || working) return;
    if (plan.errors.length) return setProblem(plan.errors[0]);
    if (plan.kind === "none") return setProblem("Change a setting first.");
    setBusy(true);
    try {
      if (plan.kind === "new-chat") {
        if (!newChat) return;
        const view = await newChat.start((current) => {
          const defaults = newChatDefaults(current, baseline!, draft, metadata!);
          // Checked before saving so an unusable combination stays in the form.
          createRequest(defaults, metadata!, "check", "check");
          return defaults;
        });
        await showToast({
          style: Toast.Style.Success,
          title: "New chat ready",
          message: "Quick Chat defaults updated",
        });
        if (!mounted.current) return;
        pop();
        if (view) (newChat.open ?? push)(view);
        return;
      }
      const prepared = await controller.prepare(draft, plan);
      if (prepared.status !== "ready") {
        setDraft(prepared.draft);
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
        if (mounted.current) return setDraft(result.draft);
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
    if (next) setDraft((current) => current && rebaseDraft(current, previous, next));
  }

  const submitTitle =
    plan?.kind === "new-chat"
      ? "Start New Chat with These Settings"
      : plan?.kind === "restart-resume"
        ? "Apply and Restart"
        : "Apply Changes";
  const agents = metadata.agents.filter(
    (agent) =>
      (!draft.targetId || metadata.targets.find((entry) => entry.id === draft.targetId)?.agents.includes(agent.id)) &&
      agent.transports.some((transport) => structuredTransport(metadata, transport)),
  );
  const result = state.result;
  return (
    <Form
      navigationTitle="Edit Current Session"
      isLoading={state.loading || working}
      actions={
        <ActionPanel>
          {(plan?.kind !== "new-chat" || newChat) && (
            <Action.SubmitForm title={submitTitle} icon={Icon.Checkmark} onSubmit={submit} />
          )}
          {state.connectTarget && (
            <Action.Push
              title="Connect SSH Target"
              icon={Icon.Lock}
              target={
                <ConnectTarget
                  target={target}
                  connect={(password) => controller.connectTarget(state.connectTarget!, password)}
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
              onAction={() => update({ newEnv: [...draft.newEnv, { key: "", value: "" }] })}
            />
          )}
          {draft.newEnv.length > 0 && (
            <Action
              title="Remove New Variable"
              icon={Icon.Minus}
              onAction={() => update({ newEnv: draft.newEnv.slice(0, -1) })}
            />
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
      <Form.TextField id="title" title="Title" value={draft.title} onChange={(title) => update({ title })} />
      <Form.Separator />
      {available.tuningNote && <Form.Description title="Model" text={available.tuningNote} />}
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
            update({ effort: fromChoice(value) });
          }}
        >
          {efforts.choices.map((choice) => (
            <Form.Dropdown.Item key={choice.value} value={choice.value} title={choice.title} />
          ))}
        </Form.Dropdown>
      )}
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
      <Form.Separator />
      {available.launchNote && <Form.Description title="Launch" text={available.launchNote} />}
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
      {available.transports.length > 0 && (
        <Form.Dropdown
          id="transport"
          title="Interface"
          value={draft.transport}
          info={available.terminalHidden ? "Terminal interfaces are available in Waypoint." : undefined}
          onChange={(transport) => update({ transport })}
        >
          {available.transports.map((transport) => (
            <Form.Dropdown.Item
              key={transport}
              value={transport}
              title={metadata.agents.find((agent) => agent.nativeTransport === transport)?.label ?? transport}
            />
          ))}
        </Form.Dropdown>
      )}
      {available.launch && !available.transports.length && available.terminalHidden && (
        <Form.Description
          title="Interface"
          text={`${metadata.agents.find((agent) => agent.nativeTransport === baseline.transport)?.label ?? baseline.transport}. Terminal interfaces are available in Waypoint.`}
        />
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
      {draft.newEnv.map((row, index) => [
        <Form.TextField
          key={`new-key-${index}`}
          id={`new-key-${index}`}
          title="New Variable"
          placeholder="NAME"
          value={row.key}
          onChange={(key) =>
            update({ newEnv: draft.newEnv.map((entry, i) => (i === index ? { ...entry, key } : entry)) })
          }
        />,
        <Form.PasswordField
          key={`new-value-${index}`}
          id={`new-value-${index}`}
          title=""
          placeholder="Value"
          value={row.value}
          onChange={(value) =>
            update({ newEnv: draft.newEnv.map((entry, i) => (i === index ? { ...entry, value } : entry)) })
          }
        />,
      ])}
      {available.usage && (
        <>
          <Form.Separator />
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
        </>
      )}
      <Form.Separator />
      {newChat ? (
        <>
          <Form.Dropdown
            id="agent"
            title="Agent"
            value={draft.agent}
            info="Changing the agent, target, or folder starts a new chat. This conversation keeps its settings."
            onChange={(agent) => update({ agent })}
          >
            {!agents.some((agent) => agent.id === baseline.backend) && (
              <Form.Dropdown.Item value={baseline.backend} title={baseline.backend} />
            )}
            {agents.map((agent) => (
              <Form.Dropdown.Item key={agent.id} value={agent.id} title={agent.label} />
            ))}
          </Form.Dropdown>
          <Form.Dropdown
            id="target"
            title="Execution Target"
            value={draft.targetId}
            onChange={(targetId) => update({ targetId })}
          >
            <Form.Dropdown.Item value="" title="Local · API server" />
            {metadata.targets.map((entry) => (
              <Form.Dropdown.Item key={entry.id} value={entry.id} title={`${entry.name} · SSH`} />
            ))}
            {baseline.targetId && !metadata.targets.some((entry) => entry.id === baseline.targetId) && (
              <Form.Dropdown.Item value={baseline.targetId} title={baseline.targetId} />
            )}
          </Form.Dropdown>
          <Form.TextField id="cwd" title="Working Directory" value={draft.cwd} onChange={(cwd) => update({ cwd })} />
        </>
      ) : (
        <Form.Description
          title="Runs In"
          text={`${metadata.agents.find((agent) => agent.id === baseline.backend)?.label ?? baseline.backend} · ${
            metadata.targets.find((entry) => entry.id === baseline.targetId)?.name ?? "Local server"
          }\n${baseline.cwd}\nStart a new chat from Quick Chat to change these.`}
        />
      )}
    </Form>
  );
}
