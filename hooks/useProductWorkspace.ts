import { useCallback, useEffect, useRef, useState } from "react";
import type { Product } from "../types";
import { EMPTY_WORKSPACE, MAX_PRODUCT_TABS, reduceProductWorkspace, type WorkspaceAction } from "../utils/productWorkspace";

export function useProductWorkspace() {
  const [workspace, setWorkspace] = useState(EMPTY_WORKSPACE);
  const stateRef = useRef(workspace);
  const [capacityMessage, setCapacityMessage] = useState<string | null>(null);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const sheetDirtyRef = useRef(false);
  const dispatch = useCallback((action: WorkspaceAction) => {
    const next = reduceProductWorkspace(stateRef.current, action);
    stateRef.current = next;
    sheetDirtyRef.current = Boolean(next.activeId && next.dirtyIds.includes(next.activeId));
    setWorkspace(next);
  }, []);
  const setCurrentProduct = useCallback((product: Product | null) => {
    if (product && !stateRef.current.products.some(p => p.id === product.id) && stateRef.current.products.length >= MAX_PRODUCT_TABS) {
      setCapacityMessage(`Es sind ${MAX_PRODUCT_TABS} Datenblätter geöffnet. Schließe zuerst einen Tab.`);
      return;
    }
    setCapacityMessage(null);
    dispatch(product ? { type: "open", product } : { type: "activate", id: null });
  }, [dispatch]);
  const closeTab = useCallback((id: string) => {
    if (stateRef.current.dirtyIds.includes(id)) { setPendingCloseId(id); return; }
    setCapacityMessage(null);
    dispatch({ type: "close", id });
  }, [dispatch]);
  const closeProductSheet = useCallback(() => {
    if (stateRef.current.activeId) closeTab(stateRef.current.activeId);
  }, [closeTab]);
  useEffect(() => {
    if (!workspace.dirtyIds.length) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [workspace.dirtyIds.length]);
  const confirmClose = () => { setCapacityMessage(null); if (pendingCloseId) dispatch({ type: "close", id: pendingCloseId }); setPendingCloseId(null); };
  return { workspace, dispatch, sheetDirtyRef, closeTab, closeProductSheet, setCurrentProduct,
    pendingCloseId, capacityMessage, confirmClose, cancelClose: () => setPendingCloseId(null),
    currentProduct: workspace.products.find(p => p.id === workspace.activeId) ?? null };
}
