import { Action, ActionPanel, Detail, Icon, Keyboard, List } from "@raycast/api";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ServerMetadata } from "../api/contracts";
import { TranscriptRow, transcript, selectedRow } from "../domain/transcript";
import { isStructured, sessionUrl } from "../domain/sessions";
import { useConnections } from "../hooks/useConnections";
import { useConversationFeed } from "../hooks/useSessionFeeds";
import { ConversationFeed, FeedConnection } from "../hooks/sessionFeeds";
import { LoadingView, markdownText, sessionSummary, statusIcon } from "../components/SessionPresentation";
import { ManageServers } from "./ManageServers";
import { SignInForm } from "./ServerForm";

export function ConversationScreen({
  connectionId,
  sessionId,
  metadata,
}: {
  connectionId: string;
  sessionId: string;
  metadata: ServerMetadata;
}) {
  const { state, error, refresh } = useConnections();
  if (!state && !error) return <LoadingView title="Loading connection…" />;
  const connection = state?.connections.find((item) => item.id === connectionId);
  if (!connection?.token)
    return (
      <Detail
        markdown={`## ${error ? "Saved connection unavailable" : "Sign in to view this conversation"}\n\n${error ?? "The connection was changed or removed. Open Manage Servers to reconnect."}`}
        actions={
          <ActionPanel>
            {connection && (
              <Action.Push
                title="Sign in"
                icon={Icon.Lock}
                target={<SignInForm connection={connection} onSaved={refresh} />}
              />
            )}
            <Action.Push title="Manage Servers" icon={Icon.Network} target={<ManageServers />} onPop={refresh} />
          </ActionPanel>
        }
      />
    );
  return (
    <ConversationContent
      connection={{ ...connection, token: connection.token }}
      sessionId={sessionId}
      metadata={metadata}
      refreshConnections={refresh}
    />
  );
}

function rowMarkdown(row: TranscriptRow): string {
  const body = row.kind === "tool" ? `\`\`\`text\n${row.text.replaceAll("```", "` ` `")}\n\`\`\`` : row.text;
  return `### ${markdownText(row.title)}\n\n${body || "Waiting for content…"}`;
}

function FullResponse({ feed, rowId }: { feed: ConversationFeed; rowId: string }) {
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const row = transcript(state.events).find((item) => item.id === rowId);
  return (
    <Detail
      navigationTitle={row?.title ?? "Response"}
      markdown={row ? rowMarkdown(row) : "This response is no longer in the loaded history."}
      actions={
        row ? (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Response" content={row.text} />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}

function ConversationContent({
  connection,
  sessionId,
  metadata,
  refreshConnections,
}: {
  connection: FeedConnection;
  sessionId: string;
  metadata: ServerMetadata;
  refreshConnections: () => Promise<void>;
}) {
  const [active, setActive] = useState(true);
  const { state, feed } = useConversationFeed(connection, sessionId, active);
  const [selection, setSelection] = useState<string>();
  const [following, setFollowing] = useState(true);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => transcript(state.events), [state.events]);
  const filtered = useMemo(
    () => rows.filter((row) => `${row.title} ${row.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    [rows, query],
  );
  const url = sessionUrl(connection.frontendUrl, sessionId);
  const auth = state.error?.kind === "expired-token" || state.stream === "auth-error";
  const canRead = !state.session || isStructured(state.session, metadata);
  const auxiliaryIds = [
    ...(state.session?.status === "waiting_input" ? ["pending-input"] : []),
    ...(state.questions?.questions.map((question) => `question:${question.id}`) ?? []),
    ...(auth || state.error || state.stream !== "live" ? ["connection-status"] : []),
  ];
  const selectedId =
    !following && selection && auxiliaryIds.includes(selection)
      ? selection
      : (selectedRow(filtered, selection, following && !query) ?? auxiliaryIds[0]);

  useEffect(() => {
    if (selectedId && selectedId !== selection) setSelection(selectedId);
  }, [selectedId]);
  const shared = (
    <>
      {auth && (
        <Action.Push
          title="Sign in Again"
          shortcut={{
            macOS: { modifiers: ["cmd", "shift"], key: "l" },
            Windows: { modifiers: ["ctrl", "shift"], key: "l" },
          }}
          icon={Icon.Lock}
          target={<SignInForm connection={connection} onSaved={refreshConnections} />}
          onPush={() => setActive(false)}
          onPop={() => {
            setActive(true);
            void refreshConnections();
          }}
        />
      )}
      <Action
        title={following ? "Pause Following" : "Follow Latest Response"}
        icon={following ? Icon.Pause : Icon.ArrowDown}
        shortcut={{
          macOS: { modifiers: ["cmd", "shift"], key: "f" },
          Windows: { modifiers: ["ctrl", "shift"], key: "f" },
        }}
        onAction={() => {
          setQuery("");
          setFollowing((value) => !value);
        }}
      />
      {state.hasMore && (
        <Action
          title="Load Older Messages"
          icon={Icon.ArrowUp}
          shortcut={Keyboard.Shortcut.Common.OpenWith}
          onAction={() => {
            setFollowing(false);
            void feed.loadOlder();
          }}
        />
      )}
      <Action
        title="Retry Connection"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => feed.retry()}
      />

      {url ? (
        <Action.OpenInBrowser title="Open in Waypoint" url={url} />
      ) : (
        <Action.Push
          title="Configure Frontend URL"
          icon={Icon.Network}
          target={<ManageServers />}
          onPush={() => setActive(false)}
          onPop={() => {
            setActive(true);
            void refreshConnections();
          }}
        />
      )}
    </>
  );
  const problem = auth
    ? "Sign-in expired"
    : (state.error?.message ??
      (state.stream === "live" ? "" : "Live connection unavailable. Reconnecting; loaded history is kept."));
  if (state.loading && !rows.length) return <LoadingView title="Loading conversation…" />;
  if (!canRead)
    return (
      <Detail
        navigationTitle="Open in Waypoint"
        markdown={`## This session's interface changed\n\nOpen it in Waypoint to continue reading.`}
        actions={<ActionPanel>{shared}</ActionPanel>}
      />
    );
  return (
    <List
      navigationTitle={state.session?.title || "Conversation"}
      searchBarPlaceholder="Find in this conversation…"
      searchText={query}
      onSearchTextChange={(value) => {
        setQuery(value);
        if (value) setFollowing(false);
      }}
      filtering={false}
      isShowingDetail
      isLoading={state.loading || state.loadingOlder}
      selectedItemId={selectedId}
      onSelectionChange={(id) => {
        if (id && id !== selectedId && (auxiliaryIds.includes(id) || filtered.some((row) => row.id === id))) {
          setSelection(id);
          setFollowing(false);
        }
      }}
    >
      {state.session?.status === "waiting_input" && (
        <List.Section title="Input Needed">
          <List.Item
            id="pending-input"
            title="Awaiting approval or answer"
            icon={{ source: Icon.ExclamationMark, tintColor: "#F4B860" }}
            detail={
              <List.Item.Detail markdown="## Input needed\n\nThis session is awaiting input. Open it in Waypoint to review approvals or questions. Native answers arrive in a later update." />
            }
            actions={
              <ActionPanel>
                {url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
                {shared}
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      {!!state.questions?.questions.length && (
        <List.Section title="Pending Questions">
          {state.questions.questions.map((question) => (
            <List.Item
              key={question.id}
              id={`question:${question.id}`}
              title={question.event.text || "Question from agent"}
              subtitle={question.availability}
              icon={Icon.QuestionMark}
              detail={
                <List.Item.Detail
                  markdown={`## Question · ${markdownText(question.availability)}\n\n${question.event.text}\n\nOpen in Waypoint to answer.`}
                />
              }
              actions={
                <ActionPanel>
                  {url && <Action.OpenInBrowser title="Open in Waypoint" url={url} />}
                  {shared}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {problem && (
        <List.Section title="Connection">
          <List.Item
            id="connection-status"
            title={
              auth ? "Sign in again to reconnect" : state.error ? "Could not refresh conversation" : "Reconnecting…"
            }
            subtitle="Loaded history is kept"
            icon={Icon.ExclamationMark}
            detail={<List.Item.Detail markdown={`## Connection status\n\n${problem}`} />}
            actions={<ActionPanel>{shared}</ActionPanel>}
          />
        </List.Section>
      )}
      <List.Section
        title={following ? "Conversation · Following latest" : "Conversation · Reviewing history"}
        subtitle={state.session?.status.replaceAll("_", " ")}
      >
        {filtered.map((row) => (
          <List.Item
            key={row.id}
            id={row.id}
            title={row.title}
            subtitle={row.text.replace(/\s+/g, " ").slice(0, 100)}
            icon={
              row.kind === "user"
                ? Icon.Person
                : row.kind === "tool"
                  ? Icon.Hammer
                  : row.kind === "approval"
                    ? Icon.ExclamationMark
                    : row.kind === "reasoning"
                      ? Icon.LightBulb
                      : Icon.Message
            }
            detail={
              <List.Item.Detail
                markdown={rowMarkdown(row)}
                metadata={
                  <List.Item.Detail.Metadata>
                    {state.session && (
                      <>
                        <List.Item.Detail.Metadata.Label
                          title="Session"
                          text={state.session.status.replaceAll("_", " ")}
                          icon={statusIcon(state.session.status)}
                        />
                        {state.session.context && (
                          <List.Item.Detail.Metadata.Label
                            title="Context"
                            text={`${state.session.context.used.toLocaleString()}${state.session.context.limit ? ` / ${state.session.context.limit.toLocaleString()}` : ""} tokens`}
                          />
                        )}
                        {state.session.tokens !== undefined && (
                          <List.Item.Detail.Metadata.Label
                            title="Tracked Tokens"
                            text={state.session.tokens.toLocaleString()}
                          />
                        )}
                      </>
                    )}
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.Push
                  title="View Full Response"
                  icon={Icon.Maximize}
                  target={<FullResponse feed={feed} rowId={row.id} />}
                />
                <Action.CopyToClipboard title="Copy Response" content={row.text} />
                <ActionPanel.Section>{shared}</ActionPanel.Section>
                {state.session && (
                  <Action.Push
                    title="Session Information"
                    icon={Icon.Info}
                    target={<Detail markdown={sessionSummary(state.session)} />}
                    onPush={() => setActive(false)}
                    onPop={() => setActive(true)}
                  />
                )}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      {!filtered.length && (
        <List.EmptyView
          title={state.loading ? "Loading conversation…" : query ? "No matching messages" : "No messages yet"}
          description={state.error?.message ?? "Messages and tool activity appear here as Waypoint records them."}
          actions={<ActionPanel>{shared}</ActionPanel>}
        />
      )}
    </List>
  );
}
