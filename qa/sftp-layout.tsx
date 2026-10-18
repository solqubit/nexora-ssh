// Development-only fixture: real file panes with synthetic data and no native IPC.
import { useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { HardDrive, Server } from "lucide-react";
import { FilePane } from "../src/components/SftpWorkspace";
import { emptyHostDraft } from "../src/data";
import type { SftpEntry } from "../src/types";
import "../src/styles.css";

const host = { ...emptyHostDraft("qa"), id: "qa", name: "Servidor de pruebas", address: "fixture.invalid", username: "demo", createdAt: "now", updatedAt: "now" };
const entries: SftpEntry[] = Array.from({ length: 240 }, (_, index) => ({
  name: index === 0 ? "configuración" : index === 1 ? "informe-de-infraestructura-con-un-nombre-muy-largo.json" : `registro-${String(index + 1).padStart(3, "0")}.log`,
  path: `/srv/proyecto/${index + 1}`, isDirectory: index === 0, isSymlink: false,
  size: 1024 * (index + 1), modifiedAt: "2026-10-09T12:00:00Z", permissions: "rw-r--r--", owner: "demo",
}));
const noop = () => undefined;

function Fixture() {
  const [selection, setSelection] = useState<Record<string, string[]>>({ left: [], right: [] });
  const [light, setLight] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const shared: Omit<ComponentProps<typeof FilePane>, "side" | "source" | "title" | "subtitle" | "icon" | "directory" | "selectedPaths" | "onSelect" | "onSelectPath" | "onSelectAll" | "onClearSelection"> = {
    hosts: [host], entries, busy: false, loading: false, error: null, parentPath: "/srv",
    connectionStatus: "connected", latencyMs: 24, reconnectAttempts: 0, canGoBack: false, canGoForward: false,
    favorites: [], currentFavorite: false, canPaste: false, dropActive: false,
    onSourceChange: noop, onBack: noop, onForward: noop, onToggleFavorite: noop, onOpenFavorite: noop,
    onOpen: noop, onOpenPath: noop, onRefresh: noop, onNewFolder: noop, onNewFile: noop, onRename: noop,
    onDeleteSelection: noop, onCopySelection: noop, onCutSelection: noop, onPaste: noop, onContextMenu: noop, onStartDrag: noop,
  };
  return <main data-theme={light ? "light" : "dark"} className="qa-files-layout" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--ink)" }}>
    <header className="topbar"><div className="section-caption"><strong>Pruebas visuales de archivos</strong><span>240 entradas ficticias · sin conexiones</span></div><button className="button secondary" onClick={() => setNarrow(!narrow)}>{narrow ? "Restaurar paneles" : "Probar panel estrecho"}</button><button className="button secondary" onClick={() => { document.documentElement.dataset.theme = light ? "dark" : "light"; setLight(!light); }}>Cambiar tema de prueba</button></header>
    <div className="transfer-layout" style={{ gridTemplateColumns: narrow ? "minmax(0, 1fr) 6px 180px" : "minmax(0, 1fr) 6px minmax(0, 1fr)" }}>
      {(["left", "right"] as const).map(side => <FilePane key={side} {...shared}
        side={side} source={side === "left" ? { kind: "local" } : { kind: "host", hostId: "qa" }}
        title={side === "left" ? "Mi equipo" : host.name} subtitle={side === "left" ? "Archivos de prueba locales" : "demo@fixture.invalid:22"}
        icon={side === "left" ? <HardDrive size={18} /> : <Server size={18} />}
        directory={{ path: "/srv/proyecto", entries }} selectedPaths={selection[side]}
        onBrowseHosts={side === "right" ? noop : undefined} onDisconnect={side === "right" ? noop : undefined}
        onSelect={entry => setSelection(current => ({ ...current, [side]: [entry.path] }))}
        onSelectPath={path => setSelection(current => ({ ...current, [side]: [path] }))}
        onSelectAll={selected => setSelection(current => ({ ...current, [side]: selected.map(entry => entry.path) }))}
        onClearSelection={() => setSelection(current => ({ ...current, [side]: [] }))} />)}
      <div className="pane-splitter"><i /></div>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
