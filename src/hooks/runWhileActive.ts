export async function runWhileActive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const result = await operation();
  signal.throwIfAborted();
  return result;
}
