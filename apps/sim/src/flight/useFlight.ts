import { useCallback, useSyncExternalStore } from "react";
import { flight, type FlightStatus } from "./controller.ts";

const subscribe = (fn: () => void) => flight.subscribe(fn);

/**
 * Subscribe to part of the flight status. The status object changes every frame, so select a
 * primitive (or something stable) to re-render only when it changes.
 */
export function useFlight<T>(select: (s: FlightStatus) => T): T {
  const get = useCallback(() => select(flight.status), [select]);
  return useSyncExternalStore(subscribe, get);
}
