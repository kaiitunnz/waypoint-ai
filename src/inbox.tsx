import { LaunchProps } from "@raycast/api";
import { Inbox, InboxLaunch } from "./views/Inbox";

export default function Command(props: LaunchProps<{ launchContext?: InboxLaunch }>) {
  return <Inbox launch={props.launchContext} />;
}
