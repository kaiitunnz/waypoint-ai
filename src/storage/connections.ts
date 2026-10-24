import { randomUUID } from "node:crypto";
import { Connection, ConnectionInput, ConnectionState, decodeState, normalizeConnection } from "../domain/connections";

export interface StorageAdapter {
  getItem(key: string): Promise<string | undefined>;
  setItem(key: string, value: string): Promise<void>;
}

export const connectionsKey = "waypoint.connections";

export class ConnectionStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly createId: () => string = randomUUID,
  ) {}

  async read(): Promise<ConnectionState> {
    await this.pending;
    return decodeState(await this.storage.getItem(connectionsKey));
  }

  private update<T>(change: (state: ConnectionState) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const state = decodeState(await this.storage.getItem(connectionsKey));
      const result = change(state);
      await this.storage.setItem(connectionsKey, JSON.stringify(state));
      return result;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  save(input: ConnectionInput, existingId?: string): Promise<Connection> {
    const normalized = normalizeConnection(input);
    return this.update((state) => {
      const existing = existingId ? state.connections.find((item) => item.id === existingId) : undefined;
      if (existingId && !existing) throw new Error("This server was removed. Reopen Manage Servers.");
      if (state.connections.some((item) => item.id !== existingId && item.apiUrl === normalized.apiUrl))
        throw new Error("This API URL is already saved. Edit or sign in to that server instead.");
      const sameHost = existing?.apiUrl === normalized.apiUrl;
      const connection = {
        ...normalized,
        id: sameHost ? existing.id : this.createId(),
        token: sameHost ? existing.token : undefined,
      };
      state.connections = existing
        ? state.connections.map((item) => (item.id === existingId ? connection : item))
        : [...state.connections, connection];
      if (!state.defaultId || state.defaultId === existingId) state.defaultId = connection.id;
      if (!state.activeId || state.activeId === existingId) state.activeId = connection.id;
      return connection;
    });
  }

  authenticate(id: string, apiUrl: string, token: string): Promise<void> {
    return this.update((state) => {
      const connection = state.connections.find((item) => item.id === id && item.apiUrl === apiUrl);
      if (!connection) throw new Error("This server changed or was removed. Reopen it before signing in.");
      connection.token = token;
    });
  }

  select(id: string, asDefault = false): Promise<void> {
    return this.update((state) => {
      if (!state.connections.some((item) => item.id === id))
        throw new Error("This server was removed. Refresh the list.");
      if (asDefault) state.defaultId = id;
      else state.activeId = id;
    });
  }

  remove(id: string): Promise<void> {
    return this.update((state) => {
      state.connections = state.connections.filter((item) => item.id !== id);
      if (state.defaultId === id) state.defaultId = state.connections[0]?.id;
      if (state.activeId === id) state.activeId = state.defaultId;
    });
  }
}
