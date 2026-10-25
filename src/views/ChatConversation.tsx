import { Action, ActionPanel, Detail, Icon, Keyboard, List, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { chatExchanges, chatMarkdown, conversationMarkdown, previewMessageLimit } from "../domain/chatPresentation";
import { transcript } from "../domain/transcript";
import { isStructured } from "../domain/sessions";
import { useConversationFeed } from "../hooks/useSessionFeeds";
import { ConversationFeed, FeedConnection } from "../hooks/sessionFeeds";
import { markdownText, sessionSummary } from "../components/SessionPresentation";
import { useSessionInteractions } from "../hooks/useSessionInteractions";
import {
  InteractionSection,
  ReviewInteraction,
  interactionItemIds,
  UnconfirmedActions,
  interactionStatus,
  reviewTitle,
  unconfirmedFor,
} from "./SessionInteraction";
import { sessionUrl } from "../domain/sessions";
import { ConversationContent } from "./Conversation";
import { EditSession, NewChatOption } from "./EditSession";

type ReadingMode = "conversation" | "latest";

function FullConversation({
  feed,
  mode,
  showActivity,
}: {
  feed: ConversationFeed;
  mode: ReadingMode;
  showActivity: boolean;
}) {
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const exchanges = chatExchanges(transcript(state.events));
  const waiting = !!state.session && ["starting", "running"].includes(state.session.status);
  const response = exchanges
    .at(-1)
    ?.rows.filter((row) => row.kind === "assistant")
    .map((row) => row.text)
    .join("\n\n");
  return (
    <Detail
      navigationTitle={mode === "conversation" ? "Conversation" : "Latest Response"}
      markdown={
        mode === "conversation"
          ? conversationMarkdown(exchanges, showActivity, waiting)
          : chatMarkdown(exchanges.at(-1), showActivity, waiting)
      }
      isLoading={state.loading}
      actions={
        response ? (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Latest Response" content={response} />
            <Action.Paste title="Paste Latest Response" content={response} />
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
  onPendingChange,
  hasDraft = false,
  refreshConnections,
  emptyMarkdown,
  settings,
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
  onPendingChange?: () => void;
  hasDraft?: boolean;
  refreshConnections: () => Promise<void>;
  emptyMarkdown?: string;
  // Quick Chat hides editing while a send is unsettled and offers starting a new chat with changed settings.
  settings?: { available: boolean; newChat?: NewChatOption };
}) {
  const [active, setActive] = useState(true);
  // Set while New Chat replaces the editor, so the editor's pop doesn't resume the hidden conversation.
  const handingOff = useRef(false);
  const { push } = useNavigation();
  const { state, feed } = useConversationFeed(connection, sessionId ?? "", active && !!sessionId);
  const { state: interactionState, controller: interactionController } = useSessionInteractions(
    connection,
    sessionId,
    metadata,
    feed,
  );
  const pendingOperation = interactionState.pending?.operationId;
  useEffect(() => {
    onPendingChange?.();
  }, [pendingOperation]);
  const interactionUrl = sessionId ? sessionUrl(connection.frontendUrl, sessionId) : undefined;
  const [mode, setMode] = useState<ReadingMode>("conversation");
  const [interactionSelection, setInteractionSelection] = useState<string>();
  const [showActivity, setShowActivity] = useState(false);
  const exchanges = useMemo(() => chatExchanges(transcript(state.events)), [state.events]);
  const session = state.session;
  const waiting = !!session && ["starting", "running"].includes(session.status);
  const unsupported = session && !isStructured(session, metadata);
  const problem =
    status ||
    state.error?.message ||
    (state.stream === "auth-error"
      ? "Sign-in expired. Sign in again to reconnect."
      : state.stream === "reconnecting"
        ? "Reconnecting… Your conversation is kept."
        : "");
  const interactions = interactionState.interactions;
  const unconfirmed = unconfirmedFor(interactionState, sessionId);
  const attention = [
    ...(interactionState.loadError
      ? [`- **Requests unavailable.** ${markdownText(interactionState.loadError)} Refresh to retry.`]
      : []),
    ...(unconfirmed
      ? [
          `- **Unconfirmed response.** ${markdownText(interactionState.notice ?? "Check its outcome before responding again.")}`,
        ]
      : []),
    ...interactions.map(
      (interaction) =>
        `- **${markdownText(interaction.title)}**${interactionStatus(interaction) ? ` · ${interactionStatus(interaction)}` : ""}`,
    ),
  ];
  const context = [
    connection.name,
    session?.model || metadata.agents.find((agent) => agent.id === session?.backend)?.label,
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = exchanges.at(-1);
  const response = latest?.rows
    .filter((row) => row.kind === "assistant")
    .map((row) => row.text)
    .join("\n\n");
  const turns = exchanges.filter((exchange) => exchange.prompt).length;

  useEffect(() => {
    setMode("conversation");
    setInteractionSelection(undefined);
  }, [sessionId, revision]);

  useEffect(() => {
    if (interactionSelection && !interactionItemIds(interactionState, sessionId).includes(interactionSelection))
      setInteractionSelection(undefined);
  }, [interactionState, interactionSelection, sessionId]);
  const renderMarkdown = (readingMode: ReadingMode) =>
    [
      problem
        ? `> **Needs attention**\n>\n${problem
            .split("\n")
            .map((line) => `> ${markdownText(line)}`)
            .join("\n")}\n\n---`
        : "",
      attention.length ? `> **Needs attention**\n>\n${attention.map((line) => `> ${line}`).join("\n")}\n\n---` : "",
      unsupported
        ? "## This conversation needs Waypoint\n\nIts interface changed. Open it in Waypoint to continue."
        : exchanges.length
          ? readingMode === "conversation"
            ? conversationMarkdown(exchanges, showActivity, waiting, previewMessageLimit)
            : chatMarkdown(latest, showActivity, waiting, previewMessageLimit)
          : emptyMarkdown || "",
      waiting ? "_Working…_" : "",
    ]
      .filter(Boolean)
      .join("\n\n");

  const attentionActions = (
    <ActionPanel.Section title="Needs Attention">
      {interactions.map((interaction) => (
        <ReviewInteraction
          key={interaction.key}
          interaction={interaction}
          controller={interactionController}
          url={interactionUrl}
          title={interactions.length > 1 ? `${reviewTitle(interaction)}: ${interaction.title}` : undefined}
        />
      ))}
      {unconfirmed && <UnconfirmedActions controller={interactionController} url={interactionUrl} />}
    </ActionPanel.Section>
  );
  const sendAction = composer?.text.trim() && composer.canSend && (
    <Action title="Send Message" icon={Icon.ArrowUp} onAction={composer.onSend} />
  );
  const actionPanel = (
    <ActionPanel>
      {!composer && attention.length > 0 && attentionActions}
      {sendAction}
      {!composer?.text.trim() && !status && response && (
        <Action.CopyToClipboard title="Copy Latest Response" content={response} />
      )}
      {response && (
        <Action.Paste
          title="Paste Latest Response"
          content={response}
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "p" },
            Windows: { modifiers: ["ctrl", "shift"], key: "p" },
          }}
        />
      )}
      {actions?.(setActive)}
      {composer && attention.length > 0 && attentionActions}
      <ActionPanel.Section title="Conversation">
        {turns > 1 && (
          <Action
            title={mode === "conversation" ? "Show Latest Response" : "Show Conversation"}
            icon={mode === "conversation" ? Icon.ArrowDownCircle : Icon.Message}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "f" },
              Windows: { modifiers: ["ctrl", "shift"], key: "f" },
            }}
            onAction={() => setMode((current) => (current === "conversation" ? "latest" : "conversation"))}
          />
        )}
        <Action
          title={showActivity ? "Hide Activity" : "Show Activity"}
          icon={Icon.Hammer}
          onAction={() => setShowActivity((value) => !value)}
        />
        {composer && exchanges.length > 0 && (
          <Action.Push
            title="Read Conversation at Full Width"
            icon={Icon.Maximize}
            shortcut={Keyboard.Shortcut.Common.Open}
            target={<FullConversation feed={feed} mode={mode} showActivity={showActivity} />}
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
                interactions={interactionController}
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
          onAction={() => {
            feed.retry();
            void interactionController.refresh();
          }}
        />
        {session && !unsupported && settings?.available !== false && (
          <Action.Push
            title="Edit Current Session"
            icon={Icon.Gear}
            shortcut={{
              macOS: { modifiers: ["cmd", "shift"], key: "," },
              Windows: { modifiers: ["ctrl", "shift"], key: "," },
            }}
            target={
              <EditSession
                connection={connection}
                sessionId={session.id}
                newChat={
                  settings?.newChat && {
                    ...settings.newChat,
                    open: (view) => {
                      handingOff.current = true;
                      setActive(false);
                      push(view, () => {
                        handingOff.current = false;
                        setActive(true);
                      });
                    },
                  }
                }
                onApplied={() => feed.retry()}
              />
            }
            onPush={() => setActive(false)}
            onPop={() => {
              if (!handingOff.current) setActive(true);
            }}
          />
        )}
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
        navigationTitle={`Chat · ${context}`}
        markdown={renderMarkdown(mode)}
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
      selectedItemId={interactionSelection ?? mode}
      onSelectionChange={(id) => {
        if (id === "conversation" || id === "latest") {
          setInteractionSelection(undefined);
          setMode(id);
        } else if (id?.startsWith("interaction:")) setInteractionSelection(id);
      }}
    >
      <InteractionSection
        controller={interactionController}
        sessionId={sessionId}
        url={interactionUrl}
        leading={sendAction}
      />
      <List.Section
        title="Conversation"
        subtitle={session?.status === "running" ? "Working…" : session?.status.replaceAll("_", " ")}
      >
        <List.Item
          id="conversation"
          icon={Icon.Message}
          title={session?.title || (sessionId ? "Conversation" : "New conversation")}
          accessories={[
            ...(hasDraft ? [{ icon: Icon.Pencil, tooltip: "Draft in progress" }] : []),
            ...(turns ? [{ text: `${turns}${state.hasMore ? "+" : ""} ${turns === 1 ? "turn" : "turns"}` }] : []),
          ]}
          detail={<List.Item.Detail markdown={renderMarkdown("conversation")} />}
          actions={actionPanel}
        />
        {turns > 1 && (
          <List.Item
            id="latest"
            icon={Icon.ArrowDownCircle}
            title="Latest response"
            detail={<List.Item.Detail markdown={renderMarkdown("latest")} />}
            actions={actionPanel}
          />
        )}
      </List.Section>
    </List>
  );
}
