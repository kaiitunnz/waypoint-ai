import { useEffect, useRef, useState } from "react";
import { WaypointClient, ApiError } from "../api/client";
import { Connection } from "../domain/connections";
import { connectionStore } from "../storage/raycast";

export function useServerSignIn(connection: Connection, onComplete: () => Promise<void>) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit() {
    if (busy.current) return;
    if (!password) {
      setError("Enter your Waypoint server password.");
      return;
    }
    busy.current = true;
    setLoading(true);
    const request = new AbortController();
    controller.current = request;
    try {
      const client = new WaypointClient(connection.apiUrl);
      await client.health(request.signal);
      const token = await client.login(password, request.signal);
      await client.me(token, request.signal);
      request.signal.throwIfAborted();
      await connectionStore.authenticate(connection.id, connection.apiUrl, token);
      setPassword("");
      await onComplete();
    } catch (error) {
      if (!request.signal.aborted)
        setError(
          error instanceof ApiError
            ? error.message
            : "Could not save sign-in. The server may have changed. Reopen it and retry.",
        );
    } finally {
      busy.current = false;
      if (!request.signal.aborted) setLoading(false);
    }
  }

  return {
    password,
    error,
    loading,
    submit,
    changePassword: (value: string) => {
      setPassword(value);
      setError(undefined);
    },
  };
}
