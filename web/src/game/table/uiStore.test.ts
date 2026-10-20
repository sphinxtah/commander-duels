import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_TABLE_UI, createTableUi, useTableUi } from "./uiStore";
import type { TableUiSnapshot, TableUiStore } from "./types";

describe("the table's interface store", () => {
  it("starts empty and tells its listeners about each change", () => {
    const ui = createTableUi();
    expect(ui.get()).toEqual(EMPTY_TABLE_UI);
    const listener = vi.fn();
    const stop = ui.subscribe(listener);
    const before = ui.get();
    ui.set({ hover: "hand:1" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ui.get().hover).toBe("hand:1");
    // Snapshots are never changed in place, so React can compare them.
    expect(before.hover).toBeNull();
    expect(ui.get()).not.toBe(before);
    stop();
    ui.set({ hover: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a patch changes nothing", () => {
    const ui = createTableUi({ drawer: "log" });
    const listener = vi.fn();
    ui.subscribe(listener);
    const snapshot = ui.get();
    ui.set({ drawer: "log", hover: null });
    ui.set({ focus: undefined });
    expect(listener).not.toHaveBeenCalled();
    expect(ui.get()).toBe(snapshot);
  });

  it("lets a listener unsubscribe while being told", () => {
    const ui = createTableUi();
    const second = vi.fn();
    const stop = ui.subscribe(() => stop());
    ui.subscribe(second);
    ui.set({ focusVisible: true });
    ui.set({ focusVisible: false });
    expect(second).toHaveBeenCalledTimes(2);
  });
});

function Probe({
  ui,
  select,
  onRender,
}: {
  ui: TableUiStore;
  select: (s: TableUiSnapshot) => unknown;
  onRender: () => void;
}) {
  const value = useTableUi(ui, select);
  onRender();
  return createElement("output", null, JSON.stringify(value));
}

function probe(ui: TableUiStore, select: (s: TableUiSnapshot) => unknown) {
  const onRender = vi.fn();
  render(createElement(Probe, { ui, select, onRender }));
  return onRender;
}

describe("useTableUi", () => {
  it("re-renders only when its slice changes", () => {
    const ui = createTableUi();
    const onRender = probe(ui, (s) => s.hover);
    expect(onRender).toHaveBeenCalledTimes(1);
    act(() => ui.set({ pointer: { x: 1, y: 2 } }));
    act(() => ui.set({ pointer: { x: 3, y: 4 } }));
    expect(onRender).toHaveBeenCalledTimes(1);
    act(() => ui.set({ hover: "battlefield:7" }));
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent('"battlefield:7"');
  });

  it("compares a selected object one level deep", () => {
    const ui = createTableUi();
    const onRender = probe(ui, (s) => ({ hover: s.hover, menu: s.menu }));
    act(() => ui.set({ pointer: { x: 5, y: 5 } }));
    expect(onRender).toHaveBeenCalledTimes(1);
    act(() => ui.set({ menu: "hand:2" }));
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent('"menu":"hand:2"');
  });
});
