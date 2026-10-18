import { useEffect, useRef, useState } from "react";
import { FolderOpen, FolderPlus, LockKeyhole, TerminalSquare } from "lucide-react";
import App from "../App";
import { chooseVaultFolder, clearVaultViewState, closeVault, disconnectSshSession, persistVaultViewState, restoreVaultViewState, stopAllTunnels, unlockVault, vaultInfo, type VaultInfo } from "../lib/desktop";
import { enqueueMutation, useAppStore } from "../store/appStore";
import { createInitialSnapshot } from "../data";

export function VaultShell() {
  const [active, setActive] = useState<VaultInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"create" | "open">("open");
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void vaultInfo().then(info => { if (live) { if (info) restoreVaultViewState(info.folder); else clearVaultViewState(); setActive(info); } }, reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (!active) return; window.addEventListener("beforeunload", persistVaultViewState); return () => window.removeEventListener("beforeunload", persistVaultViewState); }, [active]);
  async function selectFolder() {
    try { const selected = await chooseVaultFolder(); if (selected) { setFolder(selected); setError(""); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busyRef.current) return;
    setError("");
    if (!folder) { setError("Selecciona la carpeta de la bóveda."); return; }
    if (mode === "create" && (!name.trim() || [...password].length < 10 || password !== confirmation)) {
      setError(!name.trim() ? "Escribe el nombre de la bóveda." : password !== confirmation ? "Las contraseñas no coinciden." : "Utiliza una contraseña maestra de al menos 10 caracteres."); return;
    }
    busyRef.current = true; setBusy(true);
    try {
      const info = await unlockVault(folder, mode === "create" ? name.trim() : null, password);
      restoreVaultViewState(info.folder); setPassword(""); setConfirmation(""); setActive(info);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function leaveVault() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      // This event checks SFTP drafts/transfers before disconnecting anything.
      await new Promise<void>((resolve, reject) => {
        const detail = { resolve, reject, handled: false };
        window.dispatchEvent(new CustomEvent("nexora:prepare-vault-change", { detail }));
        if (!detail.handled) resolve();
      });
      await enqueueMutation(async () => {
        const store = useAppStore.getState();
        await Promise.all(store.tabs.map(tab => disconnectSshSession(tab.id)));
        await stopAllTunnels(); await closeVault();
        clearVaultViewState(); store.replaceSnapshot(createInitialSnapshot());
      });
      setActive(null); setFolder(""); setName(""); setPassword(""); setConfirmation(""); setError("");
    } finally { busyRef.current = false; }
  }
  if (checking) return <main className="vault-start" role="status">Abriendo Nexora…</main>;
  if (active) return <App key={active.folder} onCloseVault={leaveVault} />;
  return <main className="vault-start"><section className="vault-start-card">
    <div className="vault-brand"><span className="brand-mark"><TerminalSquare size={24} /></span><span>Nexora SSH</span></div>
    <h1>Tu bóveda, en tu carpeta</h1>
    <p>Abre una bóveda o crea una nueva para comenzar.</p>
    <div className="seg" role="group" aria-label="Bóveda">
      <button type="button" disabled={busy} aria-pressed={mode === "open"} className={mode === "open" ? "active" : ""} onClick={() => { setMode("open"); setError(""); setPassword(""); setConfirmation(""); }}><FolderOpen size={16} />Abrir bóveda</button>
      <button type="button" disabled={busy} aria-pressed={mode === "create"} className={mode === "create" ? "active" : ""} onClick={() => { setMode("create"); setError(""); setPassword(""); setConfirmation(""); }}><FolderPlus size={16} />Crear bóveda</button>
    </div>
    <form onSubmit={submit} aria-label={mode === "create" ? "Crear bóveda" : "Abrir bóveda"}>
      <fieldset disabled={busy}>
        {mode === "create" && <label className="field"><span>Nombre</span><input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="Personal, Trabajo…" required /></label>}
        <label className="field"><span>Carpeta</span><div className="vault-folder"><input readOnly value={folder} placeholder="Selecciona dónde está tu bóveda" aria-label="Carpeta de la bóveda" /><button type="button" className="button secondary" onClick={() => void selectFolder()} aria-label="Seleccionar carpeta"><FolderOpen size={17} /></button></div></label>
        <label className="field"><span>Contraseña maestra</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "create" ? "new-password" : "current-password"} required /></label>
        {mode === "create" && <><label className="field"><span>Confirmar contraseña</span><input type="password" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="new-password" required /></label><p className="field-help">Al menos 10 caracteres. Conserva esta contraseña: Nexora no puede recuperarla.</p></>}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary vault-submit" disabled={busy}><LockKeyhole size={16} />{busy ? "Abriendo…" : mode === "create" ? "Crear y abrir" : "Abrir bóveda"}</button>
    </form>
    <p className="vault-footer-note">Los cambios se guardan directamente en tu bóveda.</p>
  </section></main>;
}
