import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Form,
  Icon,
  Image,
  Keyboard,
  List,
  confirmAlert,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Interaction, InteractionDraft, Question } from "../domain/interactions";
import { InteractionController, InteractionSnapshot } from "../hooks/interactionController";
import { markdownText } from "../components/SessionPresentation";

const labels: Record<string, string> = {
  approve: "Approve",
  accept: "Approve",
  acceptForSession: "Approve for Session",
  acceptAlways: "Always Allow",
  decline: "Decline",
  cancel: "Cancel Request",
};
export const decisionLabel = (interaction: Interaction, decision: string) =>
  interaction.kind === "plan" && ["accept", "approve"].includes(decision)
    ? "Approve Plan"
    : (labels[decision] ?? decision);

export function interactionIcon(interaction: Interaction): Image.ImageLike {
  if (interaction.availability !== "actionable") return { source: Icon.Globe, tintColor: Color.SecondaryText };
  if (interaction.kind === "question") return { source: Icon.QuestionMarkCircle, tintColor: Color.Blue };
  if (interaction.kind === "plan") return { source: Icon.Map, tintColor: Color.Purple };
  return { source: Icon.Shield, tintColor: Color.Orange };
}

export function interactionStatus(interaction: Interaction): string | undefined {
  if (interaction.reason) return "In Waypoint";
  if (interaction.availability === "starting") return "Starting";
  if (interaction.availability === "unavailable") return "Unavailable";
}

export const reviewTitle = (interaction: Interaction) =>
  interaction.kind === "question" ? "Answer Question" : interaction.kind === "plan" ? "Review Plan" : "Review Request";

export const unconfirmedFor = (state: InteractionSnapshot, sessionId?: string) =>
  state.pending?.kind === "interaction" && state.pending.sessionId === sessionId;

export function interactionItemIds(state: InteractionSnapshot, sessionId?: string) {
  return [
    ...(state.loadError ? ["interaction:load-error"] : []),
    ...(unconfirmedFor(state, sessionId) ? ["interaction:unconfirmed"] : []),
    ...state.interactions.map((interaction) => `interaction:${interaction.key}`),
  ];
}

export function ReviewInteraction({
  interaction,
  controller,
  url,
  title = reviewTitle(interaction),
}: {
  interaction: Interaction;
  controller: InteractionController;
  url?: string;
  title?: string;
}) {
  return (
    <Action.Push
      title={title}
      icon={interactionIcon(interaction)}
      target={<SessionInteraction captured={interaction} controller={controller} url={url} />}
    />
  );
}

export function InteractionSection({
  controller,
  sessionId,
  url,
  leading,
  trailing,
}: {
  controller: InteractionController;
  sessionId?: string;
  url?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const unconfirmed = unconfirmedFor(state, sessionId);
  if (!unconfirmed && !state.interactions.length && !state.loadError) return null;
  return (
    <List.Section title="Needs Attention">
      {state.loadError && (
        <List.Item
          id="interaction:load-error"
          title="Requests unavailable"
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Orange }}
          detail={
            <List.Item.Detail
              markdown={`## Requests unavailable\n\n${markdownText(state.loadError)}\n\nPending approvals and plans may be missing until requests load.`}
            />
          }
          actions={
            <ActionPanel>
              {leading}
              <Action title="Retry Requests" icon={Icon.ArrowClockwise} onAction={() => controller.refresh()} />
              {trailing}
            </ActionPanel>
          }
        />
      )}
      {unconfirmed && (
        <List.Item
          id="interaction:unconfirmed"
          title="Unconfirmed response"
          icon={{ source: Icon.Warning, tintColor: Color.Red }}
          detail={
            <List.Item.Detail
              markdown={`## Unconfirmed response\n\n${markdownText(state.notice ?? "Waypoint did not confirm an earlier response. It may have reached the agent. Check its outcome before responding again.")}`}
            />
          }
          actions={
            <ActionPanel>
              {leading}
              <UnconfirmedActions controller={controller} url={url} />
              {trailing}
            </ActionPanel>
          }
        />
      )}
      {state.interactions.map((interaction) => {
        const status = interactionStatus(interaction);
        const browser = url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />;
        return (
          <List.Item
            key={interaction.key}
            id={`interaction:${interaction.key}`}
            title={interaction.title}
            icon={interactionIcon(interaction)}
            accessories={status ? [{ tag: status, tooltip: interaction.reason }] : undefined}
            detail={
              <List.Item.Detail
                markdown={[
                  `## ${markdownText(interaction.title)}`,
                  interaction.reason ? `> ${markdownText(interaction.reason)}` : "",
                  interaction.text,
                ]
                  .filter(Boolean)
                  .join("\n\n")}
              />
            }
            actions={
              <ActionPanel>
                {leading}
                {interaction.reason && browser}
                <ReviewInteraction interaction={interaction} controller={controller} url={url} />
                {!interaction.reason && browser}
                {trailing}
              </ActionPanel>
            }
          />
        );
      })}
    </List.Section>
  );
}

export function UnconfirmedActions({ controller, url }: { controller: InteractionController; url?: string }) {
  const { outcome } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return (
    <>
      {outcome === "pending" && url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
      <Action title="Check Previous Outcome" icon={Icon.MagnifyingGlass} onAction={() => controller.checkOutcome()} />
      {outcome === "resolved" ? (
        <Action title="Clear Checkpoint" icon={Icon.CheckCircle} onAction={() => controller.releasePending()} />
      ) : (
        <Action
          title="Allow Another Attempt"
          icon={Icon.ArrowClockwise}
          style={Action.Style.Destructive}
          onAction={async () => {
            if (
              await confirmAlert({
                title: "Allow another attempt?",
                message:
                  "The earlier response may already have reached the agent. Responding again can repeat its effect. Nothing is resent until you respond.",
                primaryAction: { title: "Allow Another Attempt", style: Alert.ActionStyle.Destructive },
              })
            )
              await controller.releasePending();
          }}
        />
      )}
    </>
  );
}

// Form descriptions show plain single paragraphs, so each line gets its own row without Markdown markers.
function ContextLines({ title, text }: { title: string; text: string }) {
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\*\*|__|`/g, "")
        .trim(),
    )
    .filter(Boolean);
  return (
    <>
      {lines.map((line, index) => (
        <Form.Description key={index} title={index === 0 ? title : ""} text={line} />
      ))}
    </>
  );
}

export function SessionInteraction({
  captured,
  controller,
  url,
}: {
  captured: Interaction;
  controller: InteractionController;
  url?: string;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const current = state.interactions.find((item) => item.key === captured.key);
  const eligible = current?.signature === captured.signature && current.availability === "actionable";
  const draft = state.drafts[controller.draftKey(captured)] ?? {};
  const unconfirmed = controller.owns(state.pending);
  const blockedBy =
    state.pending && !unconfirmed
      ? state.pending.kind === "interaction"
        ? "A response in another conversation is unconfirmed. Check it there first."
        : "A Quick Chat operation is unconfirmed. Check it in Quick Chat first."
      : undefined;
  const mounted = useRef(true);
  const { pop } = useNavigation();
  useEffect(() => {
    mounted.current = true;
    void controller.refresh();
    return () => {
      mounted.current = false;
    };
  }, [controller]);
  const update = (patch: Partial<InteractionDraft>) => {
    void controller.changeDraft(captured, { ...draft, ...patch });
  };
  const send = async (patch: Partial<InteractionDraft> = {}, cancel = false) => {
    if (await controller.submit(captured, { ...draft, ...patch }, cancel)) {
      if (mounted.current) pop();
    }
  };
  const ready = !state.pending && !state.loading && !state.busy && eligible;
  const status = state.loading
    ? undefined
    : !current
      ? "This request was resolved or replaced."
      : current.signature !== captured.signature
        ? "This request changed. Return to the conversation to review its current version."
        : (current.reason ??
          (current.availability === "starting"
            ? "The agent is starting. Refresh when it is ready."
            : current.availability === "unavailable"
              ? "The session is not running. Resume it in Waypoint to respond."
              : undefined));
  return (
    <Form
      navigationTitle={captured.title}
      isLoading={state.loading || state.busy}
      actions={
        <ActionPanel>
          {ready && captured.kind !== "question" && (
            <ActionPanel.Section>
              {captured.decisions.map((decision) => (
                <Action.SubmitForm
                  key={decision}
                  title={decisionLabel(captured, decision)}
                  icon={["decline", "cancel"].includes(decision) ? Icon.XMarkCircle : Icon.Checkmark}
                  style={["decline", "cancel"].includes(decision) ? Action.Style.Destructive : Action.Style.Regular}
                  onSubmit={() => send({ decision })}
                />
              ))}
            </ActionPanel.Section>
          )}
          {ready && captured.kind === "question" && (
            <ActionPanel.Section>
              <Action.SubmitForm title="Send Answer" icon={Icon.ArrowUp} onSubmit={() => send()} />
              <Action
                title="Cancel Question"
                icon={Icon.XMarkCircle}
                style={Action.Style.Destructive}
                onAction={async () => {
                  if (
                    await confirmAlert({
                      title: "Cancel this question?",
                      message: "The agent continues without an answer.",
                      primaryAction: { title: "Cancel Question", style: Alert.ActionStyle.Destructive },
                      dismissAction: { title: "Keep Question" },
                    })
                  )
                    await send({}, true);
                }}
              />
            </ActionPanel.Section>
          )}
          {unconfirmed && <UnconfirmedActions controller={controller} url={url} />}
          <ActionPanel.Section>
            <Action.Push
              title="Read Request"
              icon={Icon.Maximize}
              shortcut={Keyboard.Shortcut.Common.Open}
              target={<Detail navigationTitle={captured.title} markdown={captured.text} />}
            />
            {url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
            <Action
              title="Refresh Request"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => controller.refresh()}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    >
      {unconfirmed ? (
        <Form.Description
          title="Unconfirmed"
          text={
            state.notice ??
            state.error ??
            "An earlier response was not confirmed. Check its outcome before responding again."
          }
        />
      ) : (
        (state.error || state.notice) && (
          <Form.Description title={state.error ? "Needs attention" : ""} text={state.error ?? state.notice!} />
        )
      )}
      {blockedBy && <Form.Description title="Status" text={blockedBy} />}
      {status && <Form.Description title="Status" text={status} />}
      {!status && current?.afterApproval && (
        <Form.Description title="Status" text="An approval is also pending. Some agents need it answered first." />
      )}
      {captured.kind !== "question" && <ContextLines title="Request" text={captured.text} />}
      {captured.kind !== "question"
        ? captured.note && (
            <Form.TextArea
              id="note"
              title="Note"
              placeholder="Optional"
              value={draft.note ?? ""}
              onChange={(note) => update({ note })}
            />
          )
        : captured.questions?.map((question, index) => (
            <QuestionFields key={index} index={index} question={question} draft={draft} update={update} />
          ))}
    </Form>
  );
}

function QuestionFields({
  question,
  index,
  draft,
  update,
}: {
  question: Question;
  index: number;
  draft: InteractionDraft;
  update: (patch: Partial<InteractionDraft>) => void;
}) {
  const key = String(index);
  const selected = draft.selected?.[key] ?? [];
  const choose = (values: string[]) => update({ selected: { ...draft.selected, [key]: values } });
  const described = !question.multiple && question.options.some((option) => option.description);
  return (
    <>
      {index > 0 && <Form.Separator />}
      <Form.Description title={question.header ?? "Question"} text={question.question} />
      {described &&
        question.options.map((option) => (
          <Form.Description
            key={option.label}
            text={option.description ? `${option.label}: ${option.description}` : option.label}
          />
        ))}
      {question.options.length > 0 &&
        (question.multiple ? (
          question.options.map((option, optionIndex) => (
            <Form.Checkbox
              key={option.label}
              id={`answer-${index}-${optionIndex}`}
              title={optionIndex === 0 ? "Choices" : undefined}
              label={option.label}
              info={option.description}
              value={selected.includes(option.label)}
              onChange={(checked) =>
                choose(checked ? [...selected, option.label] : selected.filter((label) => label !== option.label))
              }
            />
          ))
        ) : (
          <Form.Dropdown
            id={`answer-${index}`}
            title="Answer"
            value={selected[0] ?? ""}
            onChange={(label) => choose(label ? [label] : [])}
          >
            <Form.Dropdown.Item value="" title="No selection" />
            {question.options.map((option) => (
              <Form.Dropdown.Item key={option.label} value={option.label} title={option.label} />
            ))}
          </Form.Dropdown>
        ))}
      <Form.TextArea
        id={`notes-${index}`}
        title={question.options.length ? "Notes" : "Answer"}
        placeholder={question.options.length ? "Optional, or your own answer" : undefined}
        value={draft.notes?.[key] ?? ""}
        onChange={(notes) => update({ notes: { ...draft.notes, [key]: notes } })}
      />
    </>
  );
}
