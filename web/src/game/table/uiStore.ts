import { useRef, useSyncExternalStore } from "react";
import type { TableUiSnapshot, TableUiStore } from "./types";

// The table's pointer-speed state (hover, focus, the risen card, the magnifier, menus, drags and
// the timer's progress) lives outside React, so moving the pointer never re-renders the game
// screen. The scene subscribes directly; components read slices through useTableUi, which
// re-renders them only when their slice changes.

export const EMPTY_TABLE_UI: TableUiSnapshot = {
  hover: null,
  focus: null,
  focusVisible: false,
  pointer: null,
  risen: null,
  magnified: null,
  menu: null,
  drawer: null,
  drag: null,
  timer: null,
};

export function createTableUi(
  initial: Partial<TableUiSnapshot> = {},
): TableUiStore {
  let snapshot: TableUiSnapshot = { ...EMPTY_TABLE_UI, ...initial };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(patch) {
      const keys = (Object.keys(patch) as (keyof TableUiSnapshot)[]).filter(
        (key) =>
          patch[key] !== undefined && !Object.is(patch[key], snapshot[key]),
      );
      // A patch that changes nothing tells nobody: listeners run only on real changes.
      if (keys.length === 0) return;
      const next = { ...snapshot };
      for (const key of keys) Object.assign(next, { [key]: patch[key] });
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}

/** A slice of the table's interface state. The component re-renders only when the slice
 * changes (compared one level deep), so a selector may build a small object. */
export function useTableUi<T>(
  store: TableUiStore,
  select: (snapshot: TableUiSnapshot) => T,
): T {
  const cache = useRef<{
    snapshot: TableUiSnapshot;
    select: (snapshot: TableUiSnapshot) => T;
    value: T;
  } | null>(null);
  const read = () => {
    const snapshot = store.get();
    const cached = cache.current;
    if (cached && cached.snapshot === snapshot && cached.select === select)
      return cached.value;
    const value = select(snapshot);
    if (cached && shallowEqual(cached.value, value)) {
      cache.current = { snapshot, select, value: cached.value };
      return cached.value;
    }
    cache.current = { snapshot, select, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}
