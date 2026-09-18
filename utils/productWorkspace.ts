import type { Product } from "../types";

export interface ProductWorkspaceState {
  products: Product[];
  activeId: string | null;
  dirtyIds: string[];
}
export const EMPTY_WORKSPACE: ProductWorkspaceState = { products: [], activeId: null, dirtyIds: [] };
export const MAX_PRODUCT_TABS = 8;
export type WorkspaceAction =
  | { type: "open"; product: Product }
  | { type: "activate"; id: string | null }
  | { type: "close"; id: string }
  | { type: "dirty"; id: string; dirty: boolean }
  | { type: "refresh" | "updated"; product: Product };

export function reduceProductWorkspace(state: ProductWorkspaceState, action: WorkspaceAction): ProductWorkspaceState {
  if (action.type === "activate") return { ...state, activeId: state.products.some(p => p.id === action.id) ? action.id : null };
  if (action.type === "dirty") {
    if (!state.products.some(p => p.id === action.id) || state.dirtyIds.includes(action.id) === action.dirty) return state;
    return { ...state, dirtyIds: action.dirty ? [...state.dirtyIds, action.id] : state.dirtyIds.filter(id => id !== action.id) };
  }
  if (action.type === "close") {
    const index = state.products.findIndex(p => p.id === action.id);
    const products = state.products.filter(p => p.id !== action.id);
    return { products, dirtyIds: state.dirtyIds.filter(id => id !== action.id),
      activeId: state.activeId === action.id ? products[Math.min(index, products.length - 1)]?.id ?? null : state.activeId };
  }
  const exists = state.products.some(p => p.id === action.product.id);
  if (action.type !== "open" && !exists) return state;
  if (!exists && state.products.length >= MAX_PRODUCT_TABS) return state;
  const products = exists
    ? state.products.map(p => p.id === action.product.id && (action.type === "updated" || !state.dirtyIds.includes(p.id)) ? action.product : p)
    : [...state.products, action.product];
  return { ...state, products, activeId: action.type === "open" ? action.product.id : state.activeId };
}
