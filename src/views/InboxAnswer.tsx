import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { WaypointClient } from "../api/client";
import { InboxBlock, InboxItem } from "../api/inbox";
import { InboxForm, initialForm } from "../domain/inbox";
import { InboxReplySubmitter } from "../hooks/inboxReply";
import { FeedConnection } from "../hooks/sessionFeeds";
import { quickChatStore } from "../storage/raycast";

const blockText = (block: InboxBlock) =>
  block.type === "markdown"
    ? block.text
    : block.type === "attachment"
      ? (block.ref.filename ?? "Unavailable attachment")
      : block.type === "question"
        ? block.question
        : block.type === "approval"
          ? `${block.prompt}${block.answer ? `\n\nDecision: ${block.answer.decision}` : ""}`
          : "This block needs a newer version of Waypoint AI.";

// Answers a question or replies to any block. A reply replaces the block's earlier one, so the form opens on it.
export function InboxAnswer({
  connection,
  item,
  block,
  answering,
  onSaved,
  onDeleted,
}: {
  connection: FeedConnection;
  item: InboxItem;
  block: InboxBlock;
  answering: boolean;
  onSaved: (item: InboxItem) => void;
  onDeleted: () => void;
}) {
  const { pop } = useNavigation();
  const submitter = useMemo(
    () =>
      new InboxReplySubmitter(new WaypointClient(connection.apiUrl), connection, item, block.id, quickChatStore.drafts),
    [connection.id, connection.apiUrl, connection.token, item.id, block.id],
  );
  const [form, setForm] = useState<InboxForm>();
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [, setFilesAllowed] = useState(submitter.filesAllowed);
  useEffect(() => {
    let current = true;
    submitter.readDraft().then(
      (draft) => current && setForm(initialForm(block, draft)),
      () => current && setForm(initialForm(block, undefined)),
    );
    return () => {
      current = false;
      void submitter.discard();
    };
  }, [submitter]);
  if (!form) return <Form isLoading />;
  const update = (patch: Partial<InboxForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    setProblem(undefined);
    void submitter.saveDraft(next);
  };
  const question = answering && block.type === "question" ? block : undefined;
  const earlier = block.reply?.attachments ?? [];
  async function submit() {
    if (busy || !form) return;
    setBusy(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: answering ? "Sending answer…" : "Sending reply…",
    });
    try {
      const outcome = await submitter.submit(block, form, files, answering);
      if (outcome.kind === "saved") {
        toast.style = Toast.Style.Success;
        toast.title = answering ? "Answer sent" : "Reply sent";
        onSaved(outcome.item);
        pop();
        return;
      }
      toast.style = Toast.Style.Failure;
      if (outcome.kind === "invalid") {
        setProblem(outcome.message);
        toast.title = outcome.message;
        return;
      }
      if (outcome.kind === "session-gone") {
        setFiles([]);
        setFilesAllowed(false);
      }
      if (outcome.kind === "deleted") onDeleted();
      toast.title =
        outcome.kind === "unknown" || outcome.kind === "not-saved"
          ? "Not sent"
          : outcome.kind === "session-gone"
            ? "Files can't be attached"
            : "Couldn't send";
      toast.message = outcome.message;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Form
      navigationTitle={answering ? "Answer Question" : "Reply"}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={answering ? "Send Answer" : "Send Reply"} icon={Icon.Envelope} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title={question?.header ?? (block.type === "question" ? "Question" : item.subject)}
        text={blockText(block)}
      />
      {question &&
        (question.multi ? (
          question.options.map((option, index) => (
            <Form.Checkbox
              key={option.label}
              id={`option-${index}`}
              title={index === 0 ? "Options" : undefined}
              label={option.label}
              info={option.description}
              value={form.selected.includes(option.label)}
              onChange={(checked) =>
                update({
                  selected: question.options
                    .map((entry) => entry.label)
                    .filter((label) => (label === option.label ? checked : form.selected.includes(label))),
                })
              }
            />
          ))
        ) : (
          <Form.Dropdown
            id="choice"
            title="Answer"
            value={form.selected[0] ?? ""}
            error={problem}
            onChange={(value) => update({ selected: value ? [value] : [] })}
          >
            <Form.Dropdown.Item value="" title="No option" />
            {question.options.map((option) => (
              <Form.Dropdown.Item
                key={option.label}
                value={option.label}
                title={option.description ? `${option.label} — ${option.description}` : option.label}
              />
            ))}
          </Form.Dropdown>
        ))}
      {question && question.multi && problem && <Form.Description title="" text={problem} />}
      {question && (
        <Form.TextField
          id="other"
          title="Other"
          placeholder="Another answer"
          value={form.other}
          onChange={(other) => update({ other })}
        />
      )}
      <Form.TextArea
        id="notes"
        title="Notes"
        placeholder={answering ? "Optional notes for the session" : "Notes for the session"}
        value={form.notes}
        error={!question ? problem : undefined}
        onChange={(notes) => update({ notes })}
      />
      {earlier.length > 0 && (
        <Form.Description
          title="Attached"
          text={earlier.map((ref) => ref.filename ?? "Unavailable attachment").join("\n")}
        />
      )}
      {submitter.filesAllowed && (
        <Form.FilePicker
          id="files"
          title="Files"
          value={files}
          onChange={(paths) => {
            setFiles(paths);
            setProblem(undefined);
          }}
        />
      )}
    </Form>
  );
}
