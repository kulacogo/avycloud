import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_WORKSPACE, MAX_PRODUCT_TABS, reduceProductWorkspace } from "./productWorkspace.ts";
import type { Product } from "../types.ts";
const product = (id: string, name = id) => ({ id, identification: { name } }) as Product;
test("different products stay open; reopening never duplicates a tab", () => {
  let state = reduceProductWorkspace(EMPTY_WORKSPACE, { type: "open", product: product("a") });
  state = reduceProductWorkspace(state, { type: "open", product: product("b") });
  state = reduceProductWorkspace(state, { type: "open", product: product("a") });
  assert.deepEqual(state.products.map(p => p.id), ["a", "b"]);
  assert.equal(state.activeId, "a");
});
test("dirty drafts survive list navigation, switching and background refreshes", () => {
  let state = reduceProductWorkspace(EMPTY_WORKSPACE, { type: "open", product: product("a", "Draft") });
  state = reduceProductWorkspace(state, { type: "dirty", id: "a", dirty: true });
  state = reduceProductWorkspace(state, { type: "activate", id: null });
  state = reduceProductWorkspace(state, { type: "refresh", product: product("a", "Stale") });
  assert.equal(state.products[0].identification.name, "Draft");
  assert.equal(state.activeId, null);
  assert.deepEqual(state.dirtyIds, ["a"]);
});
test("closing another tab does not lose active edits; closing active selects its neighbor", () => {
  let state = reduceProductWorkspace(EMPTY_WORKSPACE, { type: "open", product: product("a") });
  state = reduceProductWorkspace(state, { type: "open", product: product("b") });
  state = reduceProductWorkspace(state, { type: "dirty", id: "a", dirty: true });
  state = reduceProductWorkspace(state, { type: "close", id: "b" });
  assert.equal(state.activeId, "a");
  assert.deepEqual(state.dirtyIds, ["a"]);
  state = reduceProductWorkspace(state, { type: "close", id: "a" });
  assert.deepEqual(state, EMPTY_WORKSPACE);
});
test("background saves never activate another tab and tab cap never discards existing work", () => {
  let state = EMPTY_WORKSPACE;
  for (let i = 0; i < MAX_PRODUCT_TABS; i++) state = reduceProductWorkspace(state, { type: "open", product: product(String(i)) });
  const full = state;
  assert.equal(reduceProductWorkspace(state, { type: "open", product: product("overflow") }), full);
  state = reduceProductWorkspace(state, { type: "refresh", product: product("0", "Saved") });
  assert.equal(state.activeId, String(MAX_PRODUCT_TABS - 1));
  assert.equal(state.products[0].identification.name, "Saved");
});
test("a completed save replaces the tab baseline without activating it or discarding other drafts", () => {
  let state = reduceProductWorkspace(EMPTY_WORKSPACE, { type: "open", product: product("a") });
  state = reduceProductWorkspace(state, { type: "dirty", id: "a", dirty: true });
  state = reduceProductWorkspace(state, { type: "open", product: product("b") });
  state = reduceProductWorkspace(state, { type: "updated", product: product("a", "Saved title") });
  assert.equal(state.products[0].identification.name, "Saved title");
  assert.equal(state.activeId, "b");
  assert.deepEqual(state.dirtyIds, ["a"]);
  state = reduceProductWorkspace(state, { type: "dirty", id: "a", dirty: false });
  assert.deepEqual(state.dirtyIds, []);
});
