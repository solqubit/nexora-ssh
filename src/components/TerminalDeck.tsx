import { lazy, Suspense, useEffect, useRef } from "react";
import { Columns2, Rows2, Grid2X2, Maximize2, Minimize2, FolderInput, GripVertical, Plus } from "lucide-react";
import { useAppStore } from "../store/appStore";
import type { AppPreferences } from "../lib/preferences";
import type { Host } from "../types";
import { sessionTarget, LOCAL_POWERSHELL_ID } from "../lib/sessionTarget";
import { ActionMenu } from "./ActionMenu";
const TerminalPane = lazy(() => import("./TerminalPane").then(module => ({ default: module.TerminalPane })));

export function TerminalDeck({ visible, preferences, onPreferencesChange, onSaveTemporary, onForgetTemporary }: { visible: boolean; preferences: AppPreferences; onPreferencesChange: (value: Partial<AppPreferences>) => void; onSaveTemporary?: (hostId: string) => void; onForgetTemporary?: (host: Host) => void }) {
  const store = useAppStore();
  const deckRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  const paneIds = store.paneIds.filter(id => store.tabs.some(tab => tab.id === id));
  const shown = store.maximizedPaneId ? [store.maximizedPaneId] : paneIds;
  const slots = new Map(shown.map((id, index) => [id, index]));
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!deckRef.current) return;
    resizeCleanupRef.current?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    const resize = (move: PointerEvent) => {
      const bounds = deckRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const horizontal = store.terminalLayout !== "rows";
      store.setSplitRatio(100 * (horizontal ? (move.clientX - bounds.left) / bounds.width : (move.clientY - bounds.top) / bounds.height));
    };
    const end = () => { window.removeEventListener("pointermove", resize); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); resizeCleanupRef.current = null; };
    resizeCleanupRef.current = end;
    window.addEventListener("pointermove", resize); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  };
  return <div className="terminal-deck-shell" hidden={!visible}>
    <div ref={deckRef} className={`terminal-deck layout-${store.terminalLayout} panes-${shown.length}`} style={{ "--split-ratio": `${store.splitRatio}%` } as React.CSSProperties}>
      {store.tabs.map(tab => {
        const host = sessionTarget(store.snapshot, tab.hostId, store.temporaryHosts);
        if (!host) return null;
        const slot = slots.get(tab.id);
        const isVisible = visible && slot !== undefined;
        const position = slot === undefined ? {} : store.terminalLayout === "rows" ? { gridRow: slot + 1, gridColumn: 1 } : store.terminalLayout === "columns" || shown.length < 3 ? { gridRow: 1, gridColumn: slot + 1 } : { gridRow: Math.floor(slot / 2) + 1, gridColumn: slot % 2 + 1 };
        return <div key={tab.id} className={`terminal-cell ${tab.id === store.activeTabId ? "focused" : ""}`} style={position} hidden={!isVisible} onFocusCapture={() => { if (store.activeTabId !== tab.id) store.setActiveTab(tab.id); }} onPointerDownCapture={() => { if (store.activeTabId !== tab.id) store.setActiveTab(tab.id); }} onDragOver={event => { if (event.dataTransfer.types.includes("application/x-nexora-pane")) event.preventDefault(); }} onDrop={event => { const id = event.dataTransfer.getData("application/x-nexora-pane"); if (id) { event.preventDefault(); store.reorderPanes(id, tab.id); } }}>
          {shown.length > 1 && <button className="pane-drag-handle" draggable aria-label={`Mover panel ${tab.title}`} title="Arrastrar para intercambiar paneles" onDragStart={event => event.dataTransfer.setData("application/x-nexora-pane", tab.id)}><GripVertical size={14} /></button>}
          <Suspense fallback={<div className="terminal-loading">Preparando terminal…</div>}><TerminalPane host={host} session={tab} visible={isVisible} showSessionTitle={paneIds.length > 1} focused={isVisible && tab.id === store.activeTabId} preferences={preferences} onPreferencesChange={onPreferencesChange} onSaveTemporary={onSaveTemporary} onForgetTemporary={onForgetTemporary} /></Suspense>
        </div>;
      })}
      {shown.length === 2 && <div className="deck-splitter" role="separator" tabIndex={0} aria-label="Ajustar tamaño de terminales" aria-orientation={store.terminalLayout === "rows" ? "horizontal" : "vertical"} aria-valuenow={Math.round(store.splitRatio)} aria-valuemin={20} aria-valuemax={80} onPointerDown={startResize} onKeyDown={event => { if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) { event.preventDefault(); store.setSplitRatio(store.splitRatio + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -5 : 5)); } }} />}
    </div>
  </div>;
}

export function TerminalTools({ onFiles, onAddPane, filesAvailable = true }: { filesAvailable?: boolean; onFiles: (hostId: string) => void; onAddPane: () => void }) {
  const store = useAppStore();
  const active = store.tabs.find(tab => tab.id === store.activeTabId);
  const paneCount = store.paneIds.filter(id => store.tabs.some(tab => tab.id === id)).length;
  return <div className="terminal-tools">
    <button className="icon-button" disabled={!active || !filesAvailable} onClick={() => active && onFiles(active.hostId)} aria-label="Archivos" title={active?.hostId === LOCAL_POWERSHELL_ID ? "Abrir archivos de este equipo" : "Abrir archivos del servidor activo"}><FolderInput size={17} /></button>
    <ActionMenu label="Opciones de terminal">
      <button role="menuitem" disabled={paneCount >= 4} onClick={onAddPane}><Plus size={16} />Añadir panel</button>
      {([["columns", Columns2, "Dividir en columnas"], ["rows", Rows2, "Dividir en filas"], ["grid", Grid2X2, "Distribución en cuadrícula"]] as const).map(([layout, Icon, label]) => <button key={layout} role="menuitemradio" aria-checked={store.terminalLayout === layout} onClick={() => store.setTerminalLayout(layout)}><Icon size={16} />{label}</button>)}
      {paneCount > 1 && <button role="menuitem" onClick={() => store.maximizePane(store.maximizedPaneId ? null : store.activeTabId)}>{store.maximizedPaneId ? <Minimize2 size={16} /> : <Maximize2 size={16} />}{store.maximizedPaneId ? "Restaurar paneles" : "Ampliar panel activo"}</button>}
      <div className="context-divider" />
    </ActionMenu>
  </div>;
}
