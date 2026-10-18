import { useMemo, useRef, useState } from "react";
import { BookOpen, FolderOpen, Plus, Play, Pencil, Trash2, Save, Copy, TerminalSquare, X } from "lucide-react";
import { createId } from "../data";
import { useAppStore } from "../store/appStore";
import { expandSnippet, snippetVariables, useProductivityStore } from "../store/productivityStore";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { Disclosure } from "./Disclosure";
import type { Snippet } from "../types";
import { LOCAL_POWERSHELL_ID, sessionTarget } from "../lib/sessionTarget";
export function sendSessionText(sessionId: string, text: string, execute: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("No se pudo confirmar el envío. El comando puede haberse ejecutado; verifica esta sesión antes de repetirlo.")), 10000);
    window.dispatchEvent(new CustomEvent("nexora:send-session-text", { detail: { sessionId, text, execute, resolve: () => { window.clearTimeout(timer); resolve(); }, reject: (reason: Error) => { window.clearTimeout(timer); reject(reason); } } }));
  });
}
export function ProductivityPanel({ vaultId, onUseSnippet }: { vaultId: string; onUseSnippet: (snippet: Snippet) => void }) {
  const store = useProductivityStore();
  const [editing, setEditing] = useState<Snippet | null>(null), [deleting, setDeleting] = useState<Snippet | null>(null), [filter, setFilter] = useState("");
  const snippets = store.snippets.filter(item => item.vaultId === vaultId && `${item.name} ${item.category} ${item.description}`.toLowerCase().includes(filter.toLowerCase()));
  const createSnippet = () => setEditing({ id: createId(), vaultId, name: "", category: "General", description: "", command: "", updatedAt: new Date().toISOString() });
  return <section className="productivity-panel">
    <header><h1>Snippets</h1><button className="button primary" onClick={createSnippet}><Plus size={16} />Nuevo snippet</button></header>
    <label className="field productivity-filter"><span>Buscar</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Nombre o categoría…" /></label>
    <div className="productivity-cards">{snippets.map(snippet => <article key={snippet.id}><BookOpen size={22} /><small>{snippet.category || "General"}</small><h2>{snippet.name}</h2><p>{snippet.description}</p><pre>{snippet.command}</pre><footer><button className="button secondary" onClick={() => onUseSnippet(snippet)}><Play size={14} />Usar</button><button className="icon-button" aria-label={`Editar ${snippet.name}`} onClick={() => setEditing(snippet)}><Pencil size={16} /></button><button className="icon-button" aria-label={`Duplicar ${snippet.name}`} onClick={() => setEditing({ ...snippet, id: createId(), name: `${snippet.name} copia` })}><Copy size={16} /></button><button className="icon-button" aria-label={`Eliminar ${snippet.name}`} onClick={() => setDeleting(snippet)}><Trash2 size={16} /></button></footer></article>)}</div>
    {!snippets.length && <div className="productivity-empty"><TerminalSquare size={32} /><h2>{filter ? "No encontramos coincidencias" : "Tus comandos frecuentes, a mano"}</h2><p>Guarda los comandos que repites y elige las sesiones cada vez que los uses.</p><button className="button secondary" onClick={filter ? () => setFilter("") : createSnippet}>{filter ? "Limpiar búsqueda" : "Crear mi primer snippet"}</button></div>}
    {editing && <SnippetEditor snippet={editing} onClose={() => setEditing(null)} onSave={async snippet => { await store.saveSnippet(snippet); setEditing(null); }} />}
    {deleting && <DeleteProductivityDialog name={deleting.name} onClose={() => setDeleting(null)} onDelete={async () => { await store.deleteSnippet(deleting.id); setDeleting(null); }} />}
  </section>;
}
function SnippetEditor({ snippet, onClose, onSave }: { snippet: Snippet; onClose: () => void; onSave: (snippet: Snippet) => Promise<void> }) {
  const [draft, setDraft] = useState(snippet), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [discard, setDiscard] = useState(false);
  const busyRef = useRef(false);
  const requestClose = () => { if (busyRef.current) return; if (JSON.stringify(draft) !== JSON.stringify(snippet)) setDiscard(true); else onClose(); };
  const ref = useDialogFocus<HTMLFormElement>(requestClose, busy || discard);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { expandSnippet(draft.command, Object.fromEntries(snippetVariables(draft.command).map(name => [name, ""])), draft.shell); await onSave({ ...draft, name: draft.name.trim(), updatedAt: new Date().toISOString() }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop"><form ref={ref} className="modal snippet-editor" role="dialog" aria-modal="true" aria-label="Editar snippet" tabIndex={-1} onSubmit={event => void submit(event)}>
    <header className="modal-header"><BookOpen size={20} /><h2>Snippet</h2><button disabled={busy} type="button" className="icon-button" aria-label="Cerrar editor" onClick={requestClose}><X size={18} /></button></header>
    <div className="modal-body"><fieldset disabled={busy} className="snippet-form-fields">
      <label className="field"><span>Nombre</span><input autoFocus required maxLength={160} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field"><span>Shell del comando</span><select value={draft.shell ?? "posix"} onChange={event => setDraft({ ...draft, shell: event.target.value as Snippet["shell"] })}><option value="posix">POSIX · Linux/macOS</option><option value="powershell">PowerShell</option></select></label>
      <label className="field"><span>Comando</span><textarea className="snippet-command" rows={6} required maxLength={32000} spellCheck={false} value={draft.command} onChange={event => setDraft({ ...draft, command: event.target.value })} placeholder="journalctl -u {{servicio}} -n 100" /></label>
      <Disclosure title="Organización"><label className="field"><span>Categoría</span><input maxLength={160} value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} /></label><label className="field"><span>Descripción</span><input maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></Disclosure>
    </fieldset><p className="field-help">Usa {"{{variable}}"} sin comillas para pedir un argumento. No incluyas contraseñas.</p>{error && <p role="alert" className="form-error">{error}</p>}
    {discard && <div className="broadcast-notice" role="alert"><p>Hay cambios sin guardar. ¿Quieres descartarlos?</p><button type="button" className="button secondary" onClick={() => setDiscard(false)}>Seguir editando</button><button type="button" className="button danger" onClick={onClose}>Descartar snippet</button></div>}</div>
    <footer className="modal-footer"><button disabled={busy} type="button" className="button secondary" onClick={requestClose}>Cancelar</button><button disabled={busy} className="button primary"><Save size={15} />{busy ? "Guardando…" : "Guardar"}</button></footer>
  </form></div>;
}
function DeleteProductivityDialog({ name, onClose, onDelete }: { name: string; onClose: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const busyRef = useRef(false); const ref = useDialogFocus<HTMLDivElement>(onClose, busy);
  const title = "Eliminar snippet";
  return <div className="modal-backdrop"><div ref={ref} className="modal small-modal" role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}><header className="modal-header"><Trash2 size={20} /><h2>{title}</h2></header><div className="modal-body"><p>Se eliminará “{name}”.</p>{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button danger" disabled={busy} onClick={() => { if (busyRef.current) return; busyRef.current = true; setBusy(true); void onDelete().catch(reason => setError(String(reason))).finally(() => { busyRef.current = false; setBusy(false); }); }}>{busy ? "Eliminando…" : title}</button></footer></div></div>;
}
export function SnippetRunner({ snippet, onClose }: { snippet: Snippet; onClose: () => void }) {
  const app = useAppStore(); const variables = useMemo(() => snippetVariables(snippet.command), [snippet.command]);
  const [values, setValues] = useState<Record<string, string>>({}), [targets, setTargets] = useState<string[]>(app.activeTabId && app.tabs.some(tab => tab.id === app.activeTabId && tab.status === "connected") ? [app.activeTabId] : []), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const busyRef = useRef(false); const ref = useDialogFocus<HTMLDivElement>(onClose, busy);
  const connected = app.tabs.filter(tab => tab.status === "connected"); const selected = targets.filter(id => connected.some(tab => tab.id === id));
  let expanded = ""; try { expanded = expandSnippet(snippet.command, values, snippet.shell); } catch { /* Se muestra la plantilla hasta completar los argumentos. */ }
  const send = async (execute: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const command = expandSnippet(snippet.command, values, snippet.shell);
      if (!selected.length) throw new Error("Selecciona una sesión conectada.");
      if (variables.length && snippet.shell !== "powershell" && connected.some(tab => selected.includes(tab.id) && tab.hostId === LOCAL_POWERSHELL_ID)) throw new Error("Este snippet tiene variables POSIX. Edita el shell del comando a PowerShell antes de enviarlo a una terminal local.");
      const results = await Promise.allSettled(selected.map(id => sendSessionText(id, command, execute)));
      // Deselect every attempted target: retrying requires selecting destinations again.
      setTargets(current => current.filter(id => !selected.includes(id)));
      const failed = results.map((result, index) => result.status === "rejected" ? `${connected.find(tab => tab.id === selected[index])?.title}: ${String(result.reason)}` : null).filter(Boolean);
      if (failed.length) throw new Error(`Envío confirmado en ${results.length - failed.length} destinos; ${failed.length} sin confirmar. ${failed.join("; ")} Revisa las sesiones antes de volver a seleccionar un destino.`);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop"><div ref={ref} className="modal snippet-runner" role="dialog" aria-modal="true" aria-label={`Usar snippet ${snippet.name}`} tabIndex={-1}><header className="modal-header"><BookOpen size={20} /><div><h2>{snippet.name}</h2><p>Comprueba el comando y sus destinos.</p></div><button disabled={busy} className="icon-button" aria-label="Cerrar snippet" onClick={onClose}><X size={18} /></button></header><div className="modal-body">{variables.map(name => <label key={name} className="field"><span>{name}</span><input disabled={busy} value={values[name] ?? ""} onChange={event => setValues({ ...values, [name]: event.target.value })} /></label>)}<pre className="snippet-preview">{expanded || snippet.command}</pre><fieldset disabled={busy} className="snippet-targets"><legend>Destinos ({selected.length})</legend>{connected.map(tab => <label key={tab.id}><input type="checkbox" checked={selected.includes(tab.id)} onChange={event => setTargets(current => event.target.checked ? [...current, tab.id] : current.filter(id => id !== tab.id))} /><span>{tab.title}</span><small>{sessionTarget(app.snapshot, tab.hostId, app.temporaryHosts)?.address}</small></label>)}{!connected.length && <p>Conecta una terminal para usar este snippet.</p>}</fieldset>{selected.length > 1 && <p className="broadcast-notice">El comando se enviará a {selected.length} sesiones: {connected.filter(tab => selected.includes(tab.id)).map(tab => tab.title).join(", ")}.</p>}{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button disabled={busy || !selected.length} className="button secondary" onClick={() => void send(false)}>Insertar sin ejecutar</button><button disabled={busy || !selected.length} className="button primary" onClick={() => void send(true)}><Play size={15} />{busy ? "Enviando…" : selected.length > 1 ? `Ejecutar en ${selected.length} destinos` : "Ejecutar"}</button></footer></div></div>;
}
