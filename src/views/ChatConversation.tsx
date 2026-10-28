import { Action, ActionPanel, Detail, Icon, Keyboard, List, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { Session } from "../api/sessions";
import {
  ChatExchange,
  ChatItems,
  ChatSelection,
  chatExchanges,
  chatSelectedId,
  chatSelectionChange,
  conversationItem,
  conversationMarkdown,
  exchangeResponse,
  loadEarlierItem,
  previewMessageLimit,
  resolveTurnId,
  selectChatItem,
  turnItem,
  turnMarkdown,
  turnPreview,
  turnTitle,
} from "../domain/chatPresentation";
import { transcript } from "../domain/transcript";
import { isStructured } from "../domain/sessions";
import { useConversationFeed } from "../hooks/useSessionFeeds";
import { ConversationFeed, FeedConnection } from "../hooks/sessionFeeds";
import { gapNotice, markdownText, sessionIntro, sessionSummary } from "../components/SessionPresentation";
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

export interface ConversationActionContext {
  setActive: (active: boolean) => void;
  // False on interaction rows, which bring their own Open in Waypoint.
  browser: boolean;
}

export interface SessionActionContext {
  setActive: (active: boolean) => void;
  session: Session;
  feed: ConversationFeed;
}

// Reads one turn when `turnId` is given, otherwise the whole conversation.
function FullConversation({
  feed,
  turnId,
  showActivity,
}: {
  feed: ConversationFeed;
  turnId?: string;
  showActivity: boolean;
}) {
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const exchanges = chatExchanges(transcript(state.events), state.gaps);
  const waiting = !!state.session && ["starting", "running"].includes(state.session.status);
  const resolved = turnId === undefined ? undefined : resolveTurnId(exchanges, turnId);
  const exchange = exchanges.find((item) => item.id === resolved);
  const response = exchangeResponse(turnId === undefined ? exchanges.at(-1) : exchange);
  return (
    <Detail
      navigationTitle={turnId === undefined ? "Conversation" : exchange ? turnTitle(exchange) : "Turn"}
      markdown={
        turnId === undefined
          ? conversationMarkdown(exchanges, showActivity, waiting)
          : exchange
            ? turnMarkdown(exchange, showActivity, waiting && exchange === exchanges.at(-1))
            : ""
      }
      isLoading={state.loading}
      actions={
        response ? (
          <ActionPanel>
            <Action.CopyToClipboard
              title={turnId === undefined ? "Copy Latest Response" : "Copy Response"}
              content={response}
            />
            <Action.Paste
              title={turnId === undefined ? "Paste Latest Response" : "Paste Response"}
              content={response}
            />
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
  sessionActions,
  status,
  busy = false,
  revision = 0,
  onPendingChange,
  hasDraft = false,
  refreshConnections,
  emptyMarkdown,
  onMissing,
  onSession,
  onReturn,
  settings,
}: {
  connection: FeedConnection;
  sessionId?: string;
  metadata: ServerMetadata;
  composer: {
    text: string;
    onChange: (text: string) => void;
    onSend: () => void;
    canSend: boolean;
    accessory?: React.ComponentProps<typeof List>["searchBarAccessory"];
  };
  actions?: (context: ConversationActionContext) => React.ReactNode;
  // Listed after the Conversation section so a state-changing action never becomes the default.
  sessionActions?: (context: SessionActionContext) => React.ReactNode;
  status?: string;
  busy?: boolean;
  revision?: number;
  onPendingChange?: () => void;
  hasDraft?: boolean;
  refreshConnections: () => Promise<void>;
  emptyMarkdown?: string;
  onMissing?: (sessionId: string) => void;
  // The session's status or interface changed in the live feed.
  onSession?: (session: Session) => void;
  // A view pushed from the conversation closed, after which its checkpoint or session may have changed.
  onReturn?: () => void;
  // Editing is hidden while a send is unsettled; `newChat` starts a new chat with changed settings.
  settings?: { available: boolean; newChat?: NewChatOption };
}) {
  const [active, setActive] = useState(true);
  // Set while the new session's view replaces the editor, so the editor's pop doesn't resume the hidden conversation.
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
  const missing = state.error?.kind === "not-found";
  useEffect(() => {
    if (missing && sessionId) onMissing?.(sessionId);
  }, [missing, sessionId]);
  // A change skipped while a send was in progress is reported again once it settles.
  useEffect(() => {
    if (state.session) onSession?.(state.session);
  }, [state.session?.status, state.session?.transport, busy]);
  const interactionUrl = sessionId ? sessionUrl(connection.frontendUrl, sessionId) : undefined;
  const [selection, setSelection] = useState<ChatSelection>({ following: true });
  const [showActivity, setShowActivity] = useState(false);
  const exchanges = useMemo(() => chatExchanges(transcript(state.events), state.gaps), [state.events, state.gaps]);
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
    ...(state.gaps.length ? [`- **Earlier activity missing.** ${gapNotice}`] : []),
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
  const response = exchangeResponse(latest);
  const turns = exchanges.filter((exchange) => exchange.prompt).length;
  const items: ChatItems = {
    exchanges: unsupported ? [] : exchanges,
    loadEarlier: state.hasMore && !unsupported,
    auxiliary: interactionItemIds(interactionState, sessionId),
  };
  const selectedId = chatSelectedId(selection, items);

  // A confirmed send follows the new turn whether its confirmation or its first event arrives first.
  useEffect(() => {
    setSelection({ following: true });
  }, [sessionId, revision]);

  const renderMarkdown = (target: "conversation" | ChatExchange) =>
    [
      problem
        ? `> **Needs attention**\n>\n${problem
            .split("\n")
            .map((line) => `> ${markdownText(line)}`)
            .join("\n")}\n\n---`
        : "",
      attention.length ? `> **Needs attention**\n>\n${attention.map((line) => `> ${line}`).join("\n")}\n\n---` : "",
      unsupported
        ? `## This conversation needs Waypoint\n\nIts interface changed. ${interactionUrl ? "Open it in Waypoint to continue." : "Add a frontend URL in Manage Servers to open it in Waypoint."}`
        : target === "conversation"
          ? (exchanges.length ? conversationMarkdown(exchanges, showActivity, waiting, previewMessageLimit) : "") ||
            (session && !turns ? sessionIntro(session, metadata) : emptyMarkdown || "")
          : turnMarkdown(target, showActivity, waiting && target === latest, previewMessageLimit),
      waiting && (target === "conversation" || target === latest) ? "_Working…_" : "",
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
  const sendAction = composer.text.trim() && composer.canSend && !missing && (
    <Action title="Send Message" icon={Icon.ArrowUp} onAction={composer.onSend} />
  );
  const loadEarlierTurns = (
    <Action
      title="Load Earlier Turns"
      icon={Icon.Clock}
      onAction={async () => {
        if ((await feed.loadOlderTurn()) !== "loaded") return;
        const snapshot = feed.getSnapshot();
        const loaded = chatExchanges(transcript(snapshot.events), snapshot.gaps);
        if (!loaded.length) return;
        // A row chosen while the turns loaded keeps the selection.
        setSelection((current) =>
          current.following || current.selection !== loadEarlierItem
            ? current
            : selectChatItem(turnItem(loaded[0].id), loaded),
        );
      }}
    />
  );
  // `row` is the row the panel belongs to: a turn's panel copies and reads that turn; interaction rows bring their
  // own review actions, so they omit the Needs Attention section.
  const otherActions = (row: "conversation" | "interaction" | "load-earlier" | ChatExchange) => {
    const turn = typeof row === "string" ? undefined : row;
    const withAttention = row !== "interaction";
    const shown = turn ? exchangeResponse(turn) : response;
    return (
      <>
        {!composer.text.trim() && !status && shown && (
          <Action.CopyToClipboard title={turn ? "Copy Response" : "Copy Latest Response"} content={shown} />
        )}
        {shown && (
          <Action.Paste
            title={turn ? "Paste Response" : "Paste Latest Response"}
            content={shown}
            shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
          />
        )}
        {actions?.({ setActive, browser: withAttention })}
        {withAttention && attention.length > 0 && attentionActions}
        <ActionPanel.Section title="Conversation">
          {items.exchanges.length > 0 &&
            (turn || row === "load-earlier" ? (
              <Action
                title="Show Conversation"
                icon={Icon.Message}
                shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
                onAction={() => setSelection({ following: false, selection: conversationItem })}
              />
            ) : (
              <Action
                title="Show Latest Turn"
                icon={Icon.ArrowDownCircle}
                shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
                onAction={() => setSelection({ following: true })}
              />
            ))}
          <Action
            title={showActivity ? "Hide Activity" : "Show Activity"}
            icon={Icon.Hammer}
            onAction={() => setShowActivity((value) => !value)}
          />
          {exchanges.length > 0 && (
            <Action.Push
              title="Read Conversation at Full Width"
              icon={Icon.Maximize}
              shortcut={Keyboard.Shortcut.Common.Open}
              target={<FullConversation feed={feed} turnId={turn?.id} showActivity={showActivity} />}
              onPop={onReturn}
            />
          )}
          {sessionId && (
            <Action.Push
              title="Conversation History"
              icon={Icon.List}
              shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
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
              onPop={() => {
                setActive(true);
                onReturn?.();
              }}
            />
          )}
          {state.hasMore && row !== "load-earlier" && (
            <Action title="Load Earlier Messages" icon={Icon.Clock} onAction={() => feed.loadOlder()} />
          )}
          <Action
            title="Refresh Conversation"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => {
              feed.retry();
              void interactionController.refresh();
            }}
          />
          <Action
            title="Reload Conversation"
            icon={Icon.RotateClockwise}
            onAction={() => {
              feed.reload();
              void interactionController.refresh();
            }}
          />
          {session && !unsupported && !missing && settings?.available !== false && (
            <Action.Push
              title="Edit Current Session"
              icon={Icon.Gear}
              shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
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
                  onApplied={() => {
                    feed.retry();
                    onReturn?.();
                  }}
                />
              }
              onPush={() => setActive(false)}
              onPop={() => {
                if (!handingOff.current) setActive(true);
                onReturn?.();
              }}
            />
          )}
          {session && (
            <Action.Push
              title="Conversation Details"
              icon={Icon.Info}
              target={<Detail markdown={sessionSummary(session)} />}
              onPush={() => setActive(false)}
              onPop={() => {
                setActive(true);
                onReturn?.();
              }}
            />
          )}
        </ActionPanel.Section>
        {session && !missing && sessionActions?.({ setActive, session, feed })}
      </>
    );
  };
  const panel = (row: "conversation" | "load-earlier" | ChatExchange) => (
    <ActionPanel>
      {sendAction}
      {row === "load-earlier" && loadEarlierTurns}
      {otherActions(row)}
    </ActionPanel>
  );
  const detail = (id: string, full: () => string, preview: () => string) => (
    <List.Item.Detail markdown={id === selectedId ? full() : preview()} />
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
      isLoading={busy || (!!sessionId && (state.loading || state.loadingOlder))}
      selectedItemId={selectedId}
      onSelectionChange={(id) => {
        const next = chatSelectionChange(selection, id ?? undefined, items);
        if (next) setSelection(next);
      }}
    >
      <InteractionSection
        controller={interactionController}
        sessionId={sessionId}
        url={interactionUrl}
        leading={sendAction}
        trailing={otherActions("interaction")}
      />
      <List.Section
        title="Conversation"
        subtitle={session?.status === "running" ? "Working…" : session?.status.replaceAll("_", " ")}
      >
        <List.Item
          id={conversationItem}
          icon={Icon.Message}
          title={session?.title || (sessionId ? "Conversation" : "New conversation")}
          accessories={[
            ...(hasDraft ? [{ icon: Icon.Pencil, tooltip: "Draft in progress" }] : []),
            ...(turns ? [{ text: `${turns}${state.hasMore ? "+" : ""} ${turns === 1 ? "turn" : "turns"}` }] : []),
          ]}
          detail={detail(
            conversationItem,
            () => renderMarkdown("conversation"),
            () => (exchanges.length && !unsupported ? turnPreview(latest) : renderMarkdown("conversation")),
          )}
          actions={panel("conversation")}
        />
      </List.Section>
      {(items.exchanges.length > 0 || items.loadEarlier) && (
        <List.Section title="Turns">
          {items.loadEarlier && (
            <List.Item
              id={loadEarlierItem}
              icon={Icon.Clock}
              title="Load Earlier Turns"
              detail={
                <List.Item.Detail
                  markdown={state.loadingOlder ? "_Loading earlier turns…_" : "Earlier turns aren't loaded."}
                />
              }
              actions={panel("load-earlier")}
            />
          )}
          {items.exchanges.map((exchange) => (
            <List.Item
              key={exchange.id}
              id={turnItem(exchange.id)}
              icon={exchange.prompt ? Icon.Person : Icon.Hammer}
              title={turnTitle(exchange)}
              accessories={[
                ...(exchange.afterGap ? [{ icon: Icon.Warning, tooltip: "Earlier activity isn't loaded" }] : []),
                ...(waiting && exchange === latest ? [{ text: "Working…" }] : []),
              ]}
              detail={detail(
                turnItem(exchange.id),
                () => renderMarkdown(exchange),
                () => turnPreview(exchange),
              )}
              actions={panel(exchange)}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
