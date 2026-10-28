import { environment, LocalStorage } from "@raycast/api";
import { ConnectionStore } from "./connections";

export const connectionStore = new ConnectionStore({
  getItem: (key) => LocalStorage.getItem<string>(key),
  setItem: (key, value) => LocalStorage.setItem(key, value),
});

import { join } from "node:path";
import { ServerMutex } from "./mutex";
import { QuickChatStore } from "./quickChat";
import { ClipboardFiles } from "./clipboardFiles";

export const quickChatStore = new QuickChatStore(
  {
    getItem: (key) => LocalStorage.getItem<string>(key),
    setItem: (key, value) => LocalStorage.setItem(key, value),
    keys: async () => Object.keys(await LocalStorage.allItems()),
    entries: async () =>
      Object.entries(await LocalStorage.allItems()).flatMap(([key, value]): [string, string][] =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    removeItem: (key) => LocalStorage.removeItem(key),
  },
  new ServerMutex(join(environment.supportPath, "quick-chat-locks")),
);

export const clipboardFiles = new ClipboardFiles(
  join(environment.supportPath, "clipboard-attachments"),
  quickChatStore,
);
