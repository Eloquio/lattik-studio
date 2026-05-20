import { useStateStore } from "@json-render/react";

/**
 * Bind a json-render canvas state field to a `[value, set]` pair.
 * Mirrors the React `useState` shape but writes through to the
 * spec's `$state` so the agent and the renderer stay in sync.
 */
export function useField(field: string) {
  const store = useStateStore();
  const value = store.get(`/${field}`);
  const set = (v: unknown) => store.set(`/${field}`, v);
  return [value, set] as const;
}
