import { Connection } from "../domain/connections";
import { WaypointClient, ApiError } from "./client";
import { ServerMetadata } from "./contracts";

export type ConnectionStatus =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ready"; metadata: ServerMetadata }
  | { kind: "error"; error: ApiError };

export class ConnectionProbe {
  private controller?: AbortController;
  private generation = 0;

  cancel() {
    this.generation++;
    this.controller?.abort();
  }

  async run(
    connection: Connection,
    publish: (status: ConnectionStatus) => void,
    client = new WaypointClient(connection.apiUrl),
  ) {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => generation === this.generation && !controller.signal.aborted;
    publish({ kind: "loading" });
    try {
      await client.health(controller.signal);
      if (!current()) return;
      const status: ConnectionStatus = connection.token
        ? { kind: "ready", metadata: await client.me(connection.token, controller.signal) }
        : { kind: "signed-out" };
      if (current()) publish(status);
    } catch (error) {
      if (current())
        publish({
          kind: "error",
          error:
            error instanceof ApiError
              ? error
              : new ApiError("unreachable", "Could not connect. Retry or edit the server URL."),
        });
    }
  }
}
