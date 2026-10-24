import { Action, ActionPanel, Detail, Icon, Keyboard, List } from "@raycast/api";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { chatExchanges, chatMarkdown } from "../domain/chatPresentation";
import { transcript } from "../domain/transcript";
import { isStructured } from "../domain/sessions";
import { useConversationFeed } from "../hooks/useSessionFeeds";
import { ConversationFeed, FeedConnection } from "../hooks/sessionFeeds";
import { markdownText, sessionSummary } from "../components/SessionPresentation";
import { ConversationContent } from "./Conversation";

function FullExchange({
  feed,
  exchangeId,
  showActivity,
}: {
  feed: ConversationFeed;
  exchangeId: string;
  showActivity: boolean;
}) {
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const exchanges = chatExchanges(transcript(state.events));
  const exchange = exchanges.find((item) => item.id === exchangeId);
  const waiting =
    exchange?.id === exchanges.at(-1)?.id && !!state.session && ["starting", "running"].includes(state.session.status);
  const response = exchange?.rows
    .filter((row) => row.kind === "assistant")
    .map((row) => row.text)
    .join("\n\n");
  return (
    <Detail
      navigationTitle="Conversation"
      markdown={chatMarkdown(exchange, showActivity, waiting)}
      isLoading={state.loading}
      actions={
        response ? (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Response" content={response} />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}

export function ChatConversation({
  connection,
  sessionId,
  metadata,
  composer,
  actions,
  status,
  busy = false,
  revision = 0,
  refreshConnections,
  emptyMarkdown,
}: {
  connection: FeedConnection;
  sessionId?: string;
  metadata: ServerMetadata;
  composer?: {
    text: string;
    onChange: (text: string) => void;
    onSend: () => void;
    canSend: boolean;
    accessory?: React.ComponentProps<typeof List>["searchBarAccessory"];
  };
  actions?: (setActive: (active: boolean) => void) => React.ReactNode;
  status?: string;
  busy?: boolean;
  revision?: number;
  refreshConnections: () => Promise<void>;
  emptyMarkdown?: string;
}) {
  const [active, setActive] = useState(true);
  const { state, feed } = useConversationFeed(connection, sessionId ?? "", active && !!sessionId);
  const [selected, setSelected] = useState<{ id: string; revision: number }>();
  const [showActivity, setShowActivity] = useState(false);
  const exchanges = useMemo(() => chatExchanges(transcript(state.events)), [state.events]);
  const found = selected?.revision === revision ? exchanges.findIndex((item) => item.id === selected.id) : -1;
  const index = found >= 0 ? found : exchanges.length - 1;
  const exchange = exchanges[index];
  const session = state.session;
  const unsupported = session && !isStructured(session, metadata);
  const problem =
    status ||
    state.error?.message ||
    (state.stream === "auth-error"
      ? "Sign-in expired. Sign in again to reconnect."
      : state.stream === "reconnecting"
        ? "Reconnecting… Your conversation is kept."
        : "");
  const questions = state.questions?.questions.length;
  const context = [
    connection.name,
    session?.model || metadata.agents.find((agent) => agent.id === session?.backend)?.label,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = unsupported
    ? "## This conversation needs Waypoint\n\nIts interface changed. Open it in Waypoint to continue."
    : exchange
      ? chatMarkdown(exchange, showActivity, found < 0 && !!session && ["starting", "running"].includes(session.status))
      : emptyMarkdown || "";
  const markdown = [
    problem
      ? `> **Needs attention**\n>\n${problem
          .split("\n")
          .map((line) => `> ${markdownText(line)}`)
          .join("\n")}\n\n---`
      : "",
    questions ? `> **${questions} pending ${questions === 1 ? "question" : "questions"}**\n\n---` : "",
    body,
    session?.status === "running" || session?.status === "starting" ? "\n\n_Working…_" : "",
    !composer && exchanges.length
      ? `\n\n_Exchange ${index + 1} of ${exchanges.length}${found < 0 ? " · Latest" : " · History"}_`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const actionPanel = (
    <ActionPanel>
      {composer?.text.trim() && composer.canSend && (
        <Action title="Send Message" icon={Icon.ArrowUp} onAction={composer.onSend} />
      )}
      {!composer?.text.trim() && !status && exchange?.rows.some((row) => row.kind === "assistant") && (
        <Action.CopyToClipboard
          title="Copy Response"
          content={exchange.rows
            .filter((row) => row.kind === "assistant")
            .map((row) => row.text)
            .join("\n\n")}
        />
      )}
      {actions?.(setActive)}
      <ActionPanel.Section title="Conversation">
        {index > 0 && (
          <Action
            title="Previous Exchange"
            icon={Icon.ArrowUp}
            shortcut={{
              macOS: { modifiers: ["cmd"], key: "arrowUp" },
              Windows: { modifiers: ["ctrl"], key: "arrowUp" },
            }}
            onAction={() => setSelected({ id: exchanges[index - 1].id, revision })}
          />
        )}
        {index < exchanges.length - 1 && (
          <Action
            title="Next Exchange"
            icon={Icon.ArrowDown}
            shortcut={{
              macOS: { modifiers: ["cmd"], key: "arrowDown" },
              Windows: { modifiers: ["ctrl"], key: "arrowDown" },
            }}
            onAction={() => setSelected({ id: exchanges[index + 1].id, revision })}
          />
        )}
        <Action
          title="Show Latest Exchange"
          icon={Icon.ArrowDownCircle}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "f" },
            Windows: { modifiers: ["ctrl", "shift"], key: "f" },
          }}
          onAction={() => setSelected(undefined)}
        />
        <Action
          title={showActivity ? "Hide Activity" : "Show Activity"}
          icon={Icon.Hammer}
          onAction={() => setShowActivity((value) => !value)}
        />
        {exchange?.prompt && (
          <Action.Push
            title="Read Exchange at Full Width"
            icon={Icon.Text}
            shortcut={Keyboard.Shortcut.Common.Open}
            target={<FullExchange feed={feed} exchangeId={exchange.id} showActivity={showActivity} />}
          />
        )}
        {sessionId && (
          <Action.Push
            title="Conversation History"
            icon={Icon.List}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "h" },
              Windows: { modifiers: ["ctrl", "shift"], key: "h" },
            }}
            target={
              <ConversationContent
                connection={connection}
                sessionId={sessionId}
                metadata={metadata}
                refreshConnections={refreshConnections}
              />
            }
            onPush={() => setActive(false)}
            onPop={() => setActive(true)}
          />
        )}
        {state.hasMore && <Action title="Load Earlier Messages" icon={Icon.Clock} onAction={() => feed.loadOlder()} />}
        <Action
          title="Refresh Conversation"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={() => feed.retry()}
        />
        {session && (
          <Action.Push
            title="Conversation Details"
            icon={Icon.Info}
            target={<Detail markdown={sessionSummary(session)} />}
            onPush={() => setActive(false)}
            onPop={() => setActive(true)}
          />
        )}
      </ActionPanel.Section>
    </ActionPanel>
  );
  if (!composer)
    return (
      <Detail
        key={exchange?.id ?? "empty"}
        navigationTitle={`Chat · ${context}`}
        markdown={markdown}
        isLoading={busy || (!!sessionId && state.loading)}
        actions={actionPanel}
      />
    );
  return (
    <List
      navigationTitle={`Chat · ${context}`}
      searchBarPlaceholder="Message this conversation…"
      searchText={composer.text}
      onSearchTextChange={composer.onChange}
      filtering={false}
      searchBarAccessory={composer.accessory}
      isShowingDetail
      isLoading={busy || (!!sessionId && state.loading)}
      selectedItemId={exchange?.id ?? "empty"}
      onSelectionChange={(id) => {
        if (!busy && !state.loading && id && id !== exchange?.id && exchanges.some((item) => item.id === id))
          setSelected({ id, revision });
      }}
    >
      <List.Section
        title="Conversation"
        subtitle={session?.status === "running" ? "Working…" : session?.status.replaceAll("_", " ")}
      >
        {exchanges.length ? (
          exchanges
            .slice()
            .reverse()
            .map((item) => (
              <List.Item
                key={item.id}
                id={item.id}
                icon={Icon.Message}
                title={item.prompt?.text.replace(/\s+/g, " ").slice(0, 80) || "Waypoint"}
                subtitle={item.id === exchanges.at(-1)?.id ? "Latest" : undefined}
                detail={
                  <List.Item.Detail
                    markdown={
                      item.id === exchange?.id
                        ? markdown
                        : chatMarkdown(
                            item,
                            showActivity,
                            item.id === exchanges.at(-1)?.id &&
                              !!session &&
                              ["starting", "running"].includes(session.status),
                          )
                    }
                  />
                }
                actions={actionPanel}
              />
            ))
        ) : (
          <List.Item
            id="empty"
            title={sessionId ? "Conversation" : "New conversation"}
            icon={Icon.Message}
            detail={<List.Item.Detail markdown={markdown} />}
            actions={actionPanel}
          />
        )}
      </List.Section>
    </List>
  );
}
