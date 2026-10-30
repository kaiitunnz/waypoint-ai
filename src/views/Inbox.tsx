import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Keyboard,
  LaunchType,
  List,
  Toast,
  confirmAlert,
  launchCommand,
  showToast,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, WaypointClient } from "../api/client";
import { InboxApprovalBlock, InboxBlock, InboxItem, InboxQuestionBlock } from "../api/inbox";
import {
  blockChips,
  blockTitle,
  decisionTitle,
  findItem,
  inboxPageSize,
  itemMarkdown,
  itemSummary,
  itemText,
  pendingBlocks,
  senderName,
} from "../domain/inbox";
import { ReadPolicy } from "../hooks/inboxRead";
import { submitBlock } from "../hooks/inboxSubmit";
import { FeedConnection } from "../hooks/sessionFeeds";
import { useInboxFeed } from "../hooks/useInboxFeed";
import { draftKeys } from "../storage/drafts";
import { quickChatStore } from "../storage/raycast";
import { ServerAccessory, ServerGate } from "../components/ServerGate";
import { InboxAnswer } from "./InboxAnswer";
import { InboxSession } from "./InboxSession";
import { ManageServers } from "./ManageServers";
import { SignInForm } from "./ServerForm";

export interface InboxLaunch {
  itemId?: string;
  serverId?: string;
}

// Raycast updates the menu bar count on its own schedule; this refreshes it after a change made here.
function refreshMenuBar() {
  launchCommand({ name: "inbox-menu-bar", type: LaunchType.Background }).catch(() => undefined);
}

export function Inbox({ launch }: { launch?: InboxLaunch }) {
  return (
    <ServerGate
      navigationTitle="Waypoint · Inbox"
      signInTitle="Sign in to see the inbox"
      signInDescription={(server) => `Sign in to ${server} to answer its inbox.`}
      initialServerId={launch?.serverId}
    >
      {(connection, accessory, refresh) => (
        <InboxList
          connection={connection}
          refreshConnections={refresh}
          accessory={accessory}
          openItem={!launch?.serverId || launch.serverId === connection.id ? launch?.itemId : undefined}
        />
      )}
    </ServerGate>
  );
}

// The detail pane leaves rows narrow, so the icon carries both whether an item waits on you and whether it's unread.
function rowIcon(item: InboxItem) {
  const unread = !item.readAt;
  if (item.status === "resolved")
    return { value: { source: Icon.CheckCircle, tintColor: Color.SecondaryText }, tooltip: "Resolved" };
  const pending = pendingBlocks(item).length > 0;
  return {
    value: {
      source: unread ? Icon.CircleFilled : Icon.Circle,
      tintColor: pending ? Color.Orange : unread ? Color.Blue : Color.SecondaryText,
    },
    tooltip: `${pending ? "Needs an answer" : "Open"}${unread ? " · Unread" : ""}`,
  };
}
function InboxList({
  connection,
  refreshConnections,
  accessory,
  openItem,
}: {
  connection: FeedConnection;
  refreshConnections: () => Promise<void>;
  accessory: ServerAccessory;
  openItem?: string;
}) {
  const client = useMemo(() => new WaypointClient(connection.apiUrl), [connection.apiUrl]);
  const drafts = quickChatStore.drafts;
  const forgetDrafts = (id: string) =>
    void drafts.removePrefix(draftKeys.inboxItem(connection.id, id)).catch(() => undefined);
  const { state, feed } = useInboxFeed(connection, forgetDrafts);
  const latest = useRef(state);
  latest.current = state;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [controlled, setControlled] = useState<string>();
  const reads = useMemo(
    () =>
      new ReadPolicy(
        async (id) => {
          const item = await client.markInboxRead(connection.token, id);
          feed.apply(item);
          refreshMenuBar();
        },
        (id) => {
          const item = findItem(latest.current.sections, id);
          return !!item && !item.readAt;
        },
      ),
    [client, feed, connection.token],
  );
  useEffect(() => () => reads.stop(), [reads]);
  const { open, resolved } = state.sections;
  const shownResolved = state.showResolved ? resolved.items : [];
  const visibleIds = [...open.items, ...shownResolved].map((item) => item.id);
  const visibleKey = visibleIds.join(" ");
  useEffect(() => reads.visible(visibleIds), [reads, visibleKey]);
  useEffect(() => {
    if (!openItem) return;
    void feed.fetchItem(openItem).then(async (outcome) => {
      if (outcome === "found") {
        if (findItem(feed.getSnapshot().sections, openItem)?.status === "resolved") feed.setShowResolved(true);
        reads.expect(openItem);
        setControlled(openItem);
        setSelected(openItem);
        reads.acted(openItem);
      } else if (outcome === "deleted")
        await showToast({ style: Toast.Style.Failure, title: "This inbox item was deleted" });
    });
  }, [feed, openItem]);

  const changed = (item: InboxItem) => {
    feed.apply(item);
    reads.acted(item.id);
    refreshMenuBar();
  };
  async function decide(item: InboxItem, block: InboxApprovalBlock, decision: string) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Sending “${decision}”…` });
    const outcome = await submitBlock(client, connection.token, item.id, block.id, { answer: { decision } });
    if (outcome.kind === "saved") {
      changed(outcome.item);
      toast.style = Toast.Style.Success;
      toast.title = `Sent “${decision}”`;
      return;
    }
    if (outcome.kind === "deleted") feed.remove([item.id]);
    toast.style = Toast.Style.Failure;
    toast.title = outcome.kind === "unknown" ? "Not confirmed" : "Couldn't send the decision";
    toast.message = outcome.message;
  }
  async function deleteItem(item: InboxItem) {
    if (
      !(await confirmAlert({
        title: "Delete this inbox item?",
        message: item.subject,
        primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Deleting item…" });
    try {
      await client.deleteInboxItem(connection.token, item.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.kind === "not-found")) {
        toast.style = Toast.Style.Failure;
        toast.title = "Couldn't delete the item";
        toast.message = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    feed.remove([item.id]);
    forgetDrafts(item.id);
    refreshMenuBar();
    toast.style = Toast.Style.Success;
    toast.title = "Item deleted";
  }
  async function deleteResolved() {
    if (
      !(await confirmAlert({
        title: "Delete all resolved items?",
        message: "This removes every resolved item on this server, including ones not loaded here.",
        primaryAction: { title: "Delete Resolved", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Deleting resolved items…" });
    try {
      const ids = await client.deleteResolvedInbox(connection.token);
      feed.remove(ids);
      ids.forEach(forgetDrafts);
      toast.style = Toast.Style.Success;
      toast.title = ids.length === 1 ? "1 item deleted" : `${ids.length} items deleted`;
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't delete resolved items";
      toast.message = error instanceof Error ? error.message : String(error);
    }
  }

  const auth = state.error?.kind === "expired-token" || state.stream === "auth-error";
  const shared = (
    <>
      <Action
        title="Refresh Inbox"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => {
          reads.reset();
          feed.retry();
        }}
      />
      <Action
        title={state.showResolved ? "Hide Resolved Items" : "Show Resolved Items"}
        icon={state.showResolved ? Icon.EyeDisabled : Icon.CheckCircle}
        shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
        onAction={() => feed.setShowResolved(!state.showResolved)}
      />
      {auth && (
        <Action.Push
          title="Sign in Again"
          shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
          icon={Icon.Lock}
          target={<SignInForm connection={connection} onSaved={refreshConnections} />}
          onPop={() => void refreshConnections()}
        />
      )}
      <Action.Push
        title="Manage Servers"
        icon={Icon.Network}
        target={<ManageServers />}
        onPop={() => void refreshConnections()}
      />
    </>
  );
  const actions = (item: InboxItem) => {
    const questions = item.blocks.filter((block): block is InboxQuestionBlock => block.type === "question");
    const approvals = item.blocks.filter((block): block is InboxApprovalBlock => block.type === "approval");
    const pendingQuestion = questions.some((block) => !block.answer);
    const answerForm = (block: InboxBlock, answering: boolean) => (
      <InboxAnswer
        connection={connection}
        item={item}
        block={block}
        answering={answering}
        onSaved={changed}
        onDeleted={() => feed.remove([item.id])}
      />
    );
    const answerActions = questions.map((block) => (
      <Action.Push
        key={`answer-${block.id}`}
        title={
          questions.length > 1 ? `Answer: ${blockTitle(block)}` : block.answer ? "Change Answer" : "Answer Question"
        }
        icon={Icon.QuestionMarkCircle}
        target={answerForm(block, true)}
      />
    ));
    const reply =
      item.blocks.length === 1 ? (
        <Action.Push key="reply" title="Reply" icon={Icon.Reply} target={answerForm(item.blocks[0], false)} />
      ) : item.blocks.length > 1 ? (
        <ActionPanel.Submenu key="reply" title="Reply" icon={Icon.Reply}>
          {item.blocks.map((block) => (
            <Action.Push key={block.id} title={blockTitle(block)} target={answerForm(block, false)} />
          ))}
        </ActionPanel.Submenu>
      ) : undefined;
    const url = connection.frontendUrl && `${connection.frontendUrl}/inbox/${encodeURIComponent(item.id)}`;
    return (
      <ActionPanel>
        <ActionPanel.Section>
          {pendingQuestion ? [...answerActions, reply] : [reply, ...answerActions]}
          {approvals.flatMap((block) =>
            block.options.map((option) => (
              <Action
                key={`${block.id}-${option}`}
                title={decisionTitle(block, option, approvals.length > 1)}
                icon={block.answer?.decision === option ? Icon.CheckCircle : Icon.Circle}
                onAction={() => decide(item, block, option)}
              />
            )),
          )}
        </ActionPanel.Section>
        <ActionPanel.Section>
          {item.fromSessionId && (
            <Action.Push
              title="Open Session"
              icon={Icon.Message}
              shortcut={Keyboard.Shortcut.Common.Open}
              target={<InboxSession connection={connection} sessionId={item.fromSessionId} metadata={state.metadata} />}
              onPush={() => reads.acted(item.id)}
            />
          )}
          {url && <Action.OpenInBrowser title="Open in Waypoint" url={url} onOpen={() => reads.acted(item.id)} />}
          {!item.readAt && (
            <Action
              title="Mark as Read"
              icon={Icon.Eye}
              shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
              onAction={() => reads.acted(item.id)}
            />
          )}
          <Action.CopyToClipboard title="Copy Item Text" content={itemText(item)} />
        </ActionPanel.Section>
        <ActionPanel.Section>
          <Action
            title="Delete Item"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.Remove}
            onAction={() => deleteItem(item)}
          />
          {state.showResolved && (
            <Action
              title="Delete Resolved Items"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.RemoveAll}
              onAction={deleteResolved}
            />
          )}
        </ActionPanel.Section>
        <ActionPanel.Section>{shared}</ActionPanel.Section>
      </ActionPanel>
    );
  };
  const row = (item: InboxItem) => {
    const chips = blockChips(item);
    const updated = new Date(item.updatedAt);
    return (
      <List.Item
        key={item.id}
        id={item.id}
        title={item.subject}
        subtitle={senderName(item)}
        icon={rowIcon(item)}
        accessories={
          chips.length
            ? chips.map((chip) => ({ tag: { value: chip, color: Color.Orange } }))
            : [{ date: updated, tooltip: `Updated ${updated.toLocaleString()}` }]
        }
        detail={<List.Item.Detail markdown={selected === item.id ? itemMarkdown(item) : itemSummary(item)} />}
        actions={actions(item)}
      />
    );
  };
  const empty = !open.items.length && !shownResolved.length;
  return (
    <List
      navigationTitle={`Waypoint · Inbox · ${connection.name}`}
      searchBarPlaceholder="Search subjects and senders…"
      searchText={query}
      onSearchTextChange={(value) => {
        setQuery(value);
        reads.reset();
        feed.setQuery(value);
      }}
      filtering={false}
      throttle
      searchBarAccessory={accessory}
      isShowingDetail={!empty}
      isLoading={state.loading}
      selectedItemId={controlled}
      onSelectionChange={(id) => {
        const next = id ?? undefined;
        if (controlled && next === controlled) setControlled(undefined);
        setSelected(next);
        reads.select(next === "connection-status" ? undefined : next);
      }}
      pagination={{
        pageSize: inboxPageSize,
        hasMore: open.hasMore || (state.showResolved && resolved.hasMore),
        onLoadMore: () => feed.loadMore(),
      }}
    >
      {(state.error || state.stream === "reconnecting") && (
        <List.Section title="Connection">
          <List.Item
            id="connection-status"
            title={
              auth ? "Sign-in expired" : state.error ? "Could not refresh the inbox" : "Reconnecting to live updates…"
            }
            subtitle="Loaded items are kept"
            icon={Icon.ExclamationMark}
            detail={
              <List.Item.Detail
                markdown={`## Connection status\n\n${state.error?.message ?? "The live connection is unavailable. Loaded items remain; refresh to try again."}`}
              />
            }
            actions={<ActionPanel>{shared}</ActionPanel>}
          />
        </List.Section>
      )}
      <List.Section
        title="Open"
        subtitle={state.unresolvedCount !== undefined ? String(state.unresolvedCount) : undefined}
      >
        {open.items.map(row)}
      </List.Section>
      {state.showResolved && <List.Section title="Resolved">{resolved.items.map(row)}</List.Section>}
      {empty && (
        <List.EmptyView
          title={
            state.loading
              ? "Loading the inbox…"
              : auth
                ? "Sign in to reconnect"
                : query
                  ? "No matching items"
                  : state.showResolved
                    ? "The inbox is empty"
                    : "Nothing open"
          }
          description={
            state.error?.message ??
            (query
              ? "Try another subject or sender."
              : state.showResolved
                ? "Sessions post here with `waypoint inbox`."
                : "Show Resolved Items (⌘⇧E) to see answered items.")
          }
          icon={Icon.Tray}
          actions={<ActionPanel>{shared}</ActionPanel>}
        />
      )}
    </List>
  );
}
