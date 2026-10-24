import { LocalStorage } from "@raycast/api";
import { ConnectionStore } from "./connections";

export const connectionStore = new ConnectionStore({
  getItem: (key) => LocalStorage.getItem<string>(key),
  setItem: (key, value) => LocalStorage.setItem(key, value),
});
