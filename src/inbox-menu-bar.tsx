import { Icon, LaunchType, MenuBarExtra, launchCommand } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { senderName } from "./domain/inbox";
import { loadMenuBar } from "./hooks/inboxMenuBar";
import { connectionStore } from "./storage/raycast";

const openInbox = (context?: { itemId: string; serverId: string }) =>
  launchCommand({ name: "inbox", type: LaunchType.UserInitiated, context }).catch(() => undefined);

export default function InboxMenuBar() {
  // Raycast keeps a menu bar command loaded only while `isLoading` is set.
  const { data, isLoading } = usePromise(async () => loadMenuBar(await connectionStore.read()));
  const count = data?.kind === "items" ? data.count : 0;
  return (
    <MenuBarExtra
      isLoading={isLoading}
      icon={Icon.Tray}
      title={count ? String(count) : undefined}
      tooltip={count ? `${count} open in the Waypoint inbox` : "Waypoint inbox"}
    >
      {data?.kind === "items" && (
        <MenuBarExtra.Section title={`${data.server.name} · ${data.count ? `${data.count} open` : "Nothing open"}`}>
          {data.items.map((item) => (
            <MenuBarExtra.Item
              key={item.id}
              title={item.subject.slice(0, 60)}
              subtitle={senderName(item)}
              icon={item.readAt ? Icon.Circle : Icon.CircleFilled}
              onAction={() => openInbox({ itemId: item.id, serverId: data.server.id })}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      {data?.kind === "sign-in" && (
        <MenuBarExtra.Item
          title={`Sign in to ${data.server.name}`}
          icon={Icon.Lock}
          onAction={() => launchCommand({ name: "manage-servers", type: LaunchType.UserInitiated })}
        />
      )}
      {data?.kind === "unreachable" && (
        <MenuBarExtra.Item
          title={`Couldn't reach ${data.server.name}`}
          tooltip={data.message}
          icon={Icon.ExclamationMark}
        />
      )}
      {data?.kind === "no-server" && (
        <MenuBarExtra.Item
          title="Connect to Waypoint"
          icon={Icon.Network}
          onAction={() => launchCommand({ name: "manage-servers", type: LaunchType.UserInitiated })}
        />
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open Waypoint Inbox" icon={Icon.Tray} onAction={() => openInbox()} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
