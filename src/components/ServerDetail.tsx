import { Color, Icon, List } from "@raycast/api";
import { Connection } from "../domain/connections";
import { ConnectionStatus } from "../api/connectionProbe";

function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

export function statusLabel(status: ConnectionStatus): string {
  if (status.kind === "ready") return "Connected";
  if (status.kind === "loading") return "Checking connection…";
  if (status.kind === "signed-out") return "Sign in required";
  if (status.error.kind === "expired-token") return "Sign-in expired";
  if (status.error.kind === "unreachable") return "Server unreachable";
  return "Connection needs attention";
}

export function ServerDetail({
  connection,
  status,
  isDefault,
  isActive,
}: {
  connection: Connection;
  status: ConnectionStatus;
  isDefault: boolean;
  isActive: boolean;
}) {
  const metadata = status.kind === "ready" ? status.metadata : undefined;
  const md = escapeMarkdown;
  const defaultAgent =
    metadata?.agents.find((agent) => agent.id === metadata.defaultAgent)?.label ?? metadata?.defaultAgent;
  const markdown = metadata
    ? [
        `## ${md(connection.name)}`,
        `Default agent: **${md(defaultAgent ?? "")}**${isActive ? " · Active server" : ""}${isDefault ? " · Default server" : ""}`,
        "### Agents",
        metadata.agents.length
          ? metadata.agents
              .map(
                (agent) =>
                  `- **${md(agent.label)}** · ${agent.structured ? "Structured conversation" : "Terminal"}${agent.profiles.length ? ` · ${agent.profiles.map((profile) => md(profile.label)).join(", ")}` : ""}`,
              )
              .join("\n")
          : "No agent catalog was advertised by this server.",
        "### Execution targets",
        "- **Local** · Runs on the API server",
        ...metadata.targets.map(
          (target) =>
            `- **${md(target.name)}** · SSH · ${target.connected ? "Connected" : "Not connected"}${target.profiles.length ? ` · ${target.profiles.map((profile) => md(profile.label)).join(", ")}` : ""}`,
        ),
        "### Presets",
        metadata.presets.length
          ? metadata.presets.map((preset) => `- ${md(preset.name)}${preset.isDefault ? " · Default" : ""}`).join("\n")
          : "No saved presets.",
        ...(metadata.usageSources.length
          ? ["### Usage sources", metadata.usageSources.map((source) => `- ${md(source.label)}`).join("\n")]
          : []),
      ].join("\n\n")
    : [
        `## ${md(connection.name)}`,
        `### ${statusLabel(status)}`,
        status.kind === "error"
          ? status.error.message
          : status.kind === "signed-out"
            ? "The API is reachable. Sign in with your Waypoint server password to discover its agents and execution targets."
            : "Contacting the API and checking your saved sign-in…",
        status.kind === "error"
          ? "Use **Retry Connection**, **Sign In**, or **Edit Server** from Actions. Your saved configuration is kept."
          : "Your password is never stored. Tokens are kept in Raycast's encrypted local storage.",
      ].join("\n\n");
  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label
            title="Status"
            text={statusLabel(status)}
            icon={{
              source:
                status.kind === "ready"
                  ? Icon.CheckCircle
                  : status.kind === "error"
                    ? Icon.ExclamationMark
                    : Icon.Circle,
              tintColor:
                status.kind === "ready" ? Color.Green : status.kind === "error" ? Color.Orange : Color.SecondaryText,
            }}
          />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label title="API" text={connection.apiUrl} />
          {connection.frontendUrl && <List.Item.Detail.Metadata.Label title="Frontend" text={connection.frontendUrl} />}
        </List.Item.Detail.Metadata>
      }
    />
  );
}
