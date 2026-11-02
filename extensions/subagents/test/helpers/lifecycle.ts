/**
 * `pi.on` for map-backed test doubles: Pi runs every handler registered for an
 * event in order, so a later registration (for example a terminal-only command's
 * `session_start`) must not replace an earlier one. The stored entry runs all of
 * them and returns the last defined result.
 */
export function chainOn<H extends (...args: any[]) => unknown>(lifecycle: Map<string, H>) {
  return (event: string, handler: H) => {
    const previous = lifecycle.get(event);
    lifecycle.set(event, (previous
      ? async (...args: Parameters<H>) => {
        const first = await previous(...args);
        const next = await handler(...args);
        return next === undefined ? first : next;
      }
      : handler) as H);
  };
}
