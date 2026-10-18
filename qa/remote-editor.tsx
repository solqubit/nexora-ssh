// Development-only visual fixture. Vite's production entry excludes this page.
// This adapter never reads personal profiles or invokes native SSH/SFTP commands.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RemoteTextEditor, type RemoteTextTransport } from "../src/components/RemoteTextEditor";
import "../src/styles.css";
let text = "# Servidor de prueba local\nPort 22\nPermitRootLogin no\nPasswordAuthentication no\n";
let revision = "initial", changed = false;
const transport: RemoteTextTransport = {
  read: async () => ({ path: "/qa/sshd_config", text, revision }),
  save: async (_host, path, expected, draft) => {
    if (!changed) { text = text.replace("Port 22", "Port 2222"); revision = "external"; changed = true; }
    if (expected !== revision) return { status: "conflict", document: { path, text, revision } };
    text = draft; revision = "saved"; return { status: "saved", document: { path, text, revision }, warning: null };
  },
};
const setEditorState = () => undefined;
function Fixture() {
  const [open, setOpen] = useState(true), [saved, setSaved] = useState(false);
  return <main style={{ padding: 32 }}><h1>Vista de pruebas del editor</h1><p>Datos ficticios en memoria. El primer guardado simula un cambio externo.</p>{saved && <p role="status">Guardado confirmado en la fixture.</p>}<button className="button primary" onClick={() => setOpen(true)}>Abrir editor de prueba</button>{open && <RemoteTextEditor hostId="qa" hostName="Fixture local · datos de prueba" path="/qa/sshd_config" transport={transport} onClose={() => setOpen(false)} onSaved={() => setSaved(true)} onStateChange={setEditorState} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
