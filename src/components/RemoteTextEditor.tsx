import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, LoaderCircle, Save, X } from "lucide-react";
import { readSftpTextFile, saveSftpTextFile } from "../lib/desktop";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { Disclosure } from "./Disclosure";
import type { RemoteTextDocument, SaveRemoteTextResponse } from "../types";

export interface RemoteTextTransport { read: (hostId: string, path: string) => Promise<RemoteTextDocument>; save: (hostId: string, path: string, revision: string, text: string) => Promise<SaveRemoteTextResponse> }
const desktopTransport: RemoteTextTransport = { read: readSftpTextFile, save: saveSftpTextFile };
const normalizeLines = (text: string) => text.replace(/\r\n|\r/g, "\n");
const detectLines = (text: string): "LF" | "CRLF" => text.includes("\r\n") && !text.replaceAll("\r\n", "").includes("\n") ? "CRLF" : "LF";

export function RemoteTextEditor({ hostId, hostName, path, onClose, onSaved, onStateChange, transport = desktopTransport }: {
  hostId: string; hostName: string; path: string; onClose: () => void; onSaved: () => void; onStateChange: (state: { dirty: boolean; busy: boolean }) => void; transport?: RemoteTextTransport;
}) {
  const [base, setBase] = useState<RemoteTextDocument | null>(null), [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<RemoteTextDocument | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [discard, setDiscard] = useState(false);
  const [lineEnding, setLineEnding] = useState<"LF" | "CRLF">("LF");
  const generationRef = useRef(0), busyRef = useRef(false), mountedRef = useRef(true);
  const output = lineEnding === "CRLF" ? normalizeLines(draft).replaceAll("\n", "\r\n") : normalizeLines(draft);
  const dirty = Boolean(base && (normalizeLines(draft) !== normalizeLines(base.text) || lineEnding !== detectLines(base.text)));
  const requestClose = () => { if (busyRef.current) return; if (dirty) setDiscard(true); else onClose(); };
  const ref = useDialogFocus<HTMLDivElement>(requestClose, busy || discard);
  useEffect(() => {
    mountedRef.current = true; const generation = ++generationRef.current;
    setLoading(true); setError("");
    void transport.read(hostId, path).then(document => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setBase(document); setDraft(normalizeLines(document.text)); setLineEnding(detectLines(document.text));
    }, reason => { if (mountedRef.current && generation === generationRef.current) setError(String(reason)); }).finally(() => { if (mountedRef.current && generation === generationRef.current) setLoading(false); });
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, [hostId, path, transport]);
  useLayoutEffect(() => { onStateChange({ dirty, busy: busy || loading }); return () => onStateChange({ dirty: false, busy: false }); }, [dirty, busy, loading, onStateChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, busy]);
  const save = async (expected = base) => {
    if (!expected || busyRef.current) return;
    const generation = generationRef.current;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await transport.save(hostId, path, expected.revision, output);
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (result.status === "conflict") { setConflict(result.document); return; }
      setBase(result.document); setDraft(normalizeLines(result.document.text)); setLineEnding(detectLines(result.document.text)); setConflict(null); setMessage(result.warning ?? "Archivo guardado en el servidor."); onSaved();
    } catch (reason) { if (mountedRef.current && generation === generationRef.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; if (mountedRef.current && generation === generationRef.current) setBusy(false); }
  };
  return <div className="modal-backdrop"><div ref={ref} className="modal remote-text-editor" role="dialog" aria-modal="true" aria-label={`Editar archivo ${path}`} tabIndex={-1} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); if (!conflict && dirty) void save(); } }}>
    <header className="modal-header"><FileText size={22} /><div><h2>Editor remoto <span>{dirty ? "· Sin guardar" : ""}</span></h2><p>{hostName} · {path}</p></div><button className="icon-button" disabled={busy} aria-label="Cerrar editor remoto" onClick={requestClose}><X size={18} /></button></header>
    <div className="modal-body">{loading ? <p role="status"><LoaderCircle className="spin" size={16} />Leyendo archivo…</p> : base && <>
      <div className={`remote-editor-panes ${conflict ? "has-conflict" : ""}`}><label className="field"><span>Tu versión</span><textarea aria-label="Contenido del archivo remoto" value={draft} onChange={event => { setDraft(event.target.value); setMessage(""); }} disabled={busy} maxLength={2 * 1024 * 1024} spellCheck={false} /></label>{conflict && <label className="field"><span>Versión actual del servidor</span><textarea aria-label="Versión del servidor" readOnly value={conflict.text} spellCheck={false} /></label>}</div>
      {conflict && <div className="remote-editor-conflict" role="alert"><AlertTriangle size={18} /><div><strong>El archivo cambió en el servidor</strong><p>Compara las versiones. Puedes combinar los cambios en tu borrador o reemplazar la revisión que se muestra. El servidor se comprobará otra vez antes de guardar.</p><button className="button secondary" disabled={busy} onClick={() => { setBase(conflict); setDraft(normalizeLines(conflict.text)); setLineEnding(detectLines(conflict.text)); setConflict(null); setMessage("Usando la versión actual del servidor."); }}>Descartar mi borrador y usar el servidor</button><button className="button danger" disabled={busy} onClick={() => void save(conflict)}>Guardar mi versión sobre esta revisión</button></div></div>}
      <Disclosure title="Formato del archivo">
        <label className="field remote-editor-ending"><span>Fin de línea</span><select value={lineEnding} disabled={busy} onChange={event => setLineEnding(event.target.value as "LF" | "CRLF")}><option value="LF">LF · Linux/macOS</option><option value="CRLF">CRLF · Windows</option></select></label>
        <p className="field-help">Texto UTF-8 · máximo 2 MB. Se conservan permisos y propietario.</p>
        <p className="field-help">Al guardar se reemplaza el archivo; no se conservan ACL, atributos extendidos ni enlaces duros.</p>
      </Disclosure>
    </>}{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="broadcast-notice" role="status">{message}</p>}{discard && <div className="broadcast-notice"><p>Tu borrador tiene cambios sin guardar.</p><button className="button secondary" onClick={() => setDiscard(false)}>Seguir editando</button><button className="button danger" onClick={onClose}>Descartar borrador y cerrar</button></div>}</div>
    <footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={requestClose}>Cerrar</button><button className="button primary" title="Guardar · Ctrl/Cmd + S" disabled={loading || busy || !dirty || Boolean(conflict)} onClick={() => void save()}><Save size={15} />{busy ? "Guardando…" : "Guardar en servidor"}</button></footer>
  </div></div>;
}
