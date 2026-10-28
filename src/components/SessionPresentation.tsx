import { Color, Detail, Icon, List } from "@raycast/api";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";

export const statusIcon = (status: string) => ({
  source:
    status === "running" || status === "starting"
      ? Icon.CircleProgress
      : status === "waiting_input" || status === "error"
        ? Icon.ExclamationMark
        : status === "exited"
          ? Icon.Stop
          : status === "interrupted"
            ? Icon.Pause
            : Icon.Circle,
  tintColor:
    status === "error"
      ? Color.Red
      : status === "waiting_input"
        ? Color.Orange
        : status === "running"
          ? Color.Green
          : Color.SecondaryText,
});
export const markdownText = (value: string) => value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
export const gapNotice =
  "Some activity while this conversation was away isn't shown. Reload Conversation to see it in order.";

export function sessionSummary(session: Session): string {
  const md = markdownText;
  return [
    `## ${md(session.title || "Untitled session")}`,
    `**${md(session.status.replaceAll("_", " "))}** · ${md(session.backend)}${session.model ? ` · ${md(session.model)}` : ""}`,
    session.repository
      ? `Repository: **${md(session.repository)}**${session.branch ? ` · ${md(session.branch)}` : ""}`
      : "",
    `Working directory: ${md(session.cwd)}`,
    session.context
      ? `Context: **${session.context.used.toLocaleString()}${session.context.limit ? ` / ${session.context.limit.toLocaleString()}` : ""} tokens**`
      : "",
    session.tokens !== undefined ? `Tracked token work: **${session.tokens.toLocaleString()}**` : "",
    ...session.rateLimits.map(
      (window) =>
        `${md(window.label)}: **${window.percent}% used**${session.usageStale ? " · Stale or unavailable" : ""}`,
    ),
    session.status === "waiting_input"
      ? "### Input needed\n\nThis session is awaiting an approval or answer. Open it in Waypoint to continue."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// A session started without a message has nothing to show yet, so it says where it runs.
export function sessionIntro(session: Session, metadata: ServerMetadata): string {
  const agent = metadata.agents.find((entry) => entry.id === session.backend)?.label ?? session.backend;
  const target = metadata.targets.find((entry) => entry.id === session.targetId)?.name ?? "Local server";
  return [
    `## ${markdownText(session.title || "New conversation")}`,
    `**${[agent, session.model]
      .filter((part): part is string => !!part)
      .map(markdownText)
      .join(" · ")}** · ${markdownText(target)}`,
    markdownText(session.cwd),
  ].join("\n\n");
}
export function SessionDetail({ session, structured }: { session: Session; structured: boolean }) {
  return (
    <List.Item.Detail
      markdown={`${sessionSummary(session)}\n\n${structured ? "Open Conversation to review messages and follow live output." : "This session uses a terminal or an unknown interface. Open it in Waypoint."}`}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label
            title="Status"
            text={session.status.replaceAll("_", " ")}
            icon={statusIcon(session.status)}
          />
          <List.Item.Detail.Metadata.Label
            title="Interface"
            text={structured ? "Native conversation" : "Open in Waypoint"}
          />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

export function LoadingView({ title }: { title: string }) {
  return <Detail isLoading markdown={`## ${title}`} />;
}
