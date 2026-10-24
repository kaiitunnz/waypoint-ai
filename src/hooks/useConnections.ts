import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, ConnectionState } from "../domain/connections";
import { ConnectionProbe, ConnectionStatus } from "../api/connectionProbe";
import { connectionStore } from "../storage/raycast";

export function useConnections() {
  const [state, setState] = useState<ConnectionState>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (mounted.current) setLoading(true);
    try {
      const next = await connectionStore.read();
      if (mounted.current && current === generation.current) {
        setState(next);
        setError(undefined);
      }
    } catch {
      if (mounted.current && current === generation.current)
        setError(
          "Saved servers could not be read. Your data has been kept. Restore the extension's saved data or retry.",
        );
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);
  return { state, loading, error, refresh };
}

export function useConnectionStatus(connection: Connection | undefined, revision: number) {
  const [result, setResult] = useState<{ key: string; status: ConnectionStatus }>();
  const key = JSON.stringify([connection?.id, connection?.apiUrl, connection?.token, revision]);
  useEffect(() => {
    if (!connection) return;
    const probe = new ConnectionProbe();
    void probe.run(connection, (status) => setResult({ key, status }));
    return () => probe.cancel();
  }, [connection?.id, connection?.apiUrl, connection?.token, revision, key]);
  return result?.key === key ? result.status : { kind: "loading" as const };
}
