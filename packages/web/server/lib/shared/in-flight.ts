export function trackOperations(inFlight: Set<Promise<unknown>>) {
  return <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) => (...args: Args) => {
    const pending = operation(...args);
    inFlight.add(pending);
    const finished = () => inFlight.delete(pending);
    void pending.then(finished, finished);
    return pending;
  };
}
