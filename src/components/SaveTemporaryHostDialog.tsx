import { useRef, useState } from "react";
import { Save, X } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import type { Host, HostGroup } from "../types";
import { useAppStore } from "../store/appStore";
import { sessionSnapshot, connectionTargetLabel } from "../lib/sessionTarget";
import { resolveConnectionProfile } from "../lib/connectionProfile";

export function SaveTemporaryHostDialog({ host, groups, onClose, onSave }: { host: Host; groups: HostGroup[]; onClose: () => void; onSave: (name: string, groupId: string | null) => Promise<void> }) {
  const [name, setName] = useState(host.name), [groupId, setGroupId] = useState(host.groupId ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const busyRef = useRef(false), ref = useDialogFocus<HTMLFormElement>(onClose, busy);
  const state = useAppStore();
  const effective = resolveConnectionProfile(sessionSnapshot(state.snapshot, state.temporaryHosts), { ...host, groupId: groupId || null });
  return <div className="modal-backdrop"><form ref={ref} className="modal small-modal" role="dialog" aria-modal="true" aria-label="Guardar conexión temporal" tabIndex={-1} onSubmit={event => { event.preventDefault(); if (busyRef.current) return; const clean = name.trim(); if (!clean || clean.length > 160) { setError("Escribe un nombre de hasta 160 caracteres."); return; } busyRef.current = true; setBusy(true); setError(""); void onSave(clean, groupId || null).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { busyRef.current = false; setBusy(false); }); }}>
    <header className="modal-header"><Save size={20} /><div><h2>Guardar host</h2><p>Conserva este acceso para la próxima vez.</p></div><button className="icon-button" type="button" disabled={busy} aria-label="Cerrar guardado" onClick={onClose}><X size={18} /></button></header>
    <div className="modal-body"><label className="field"><span>Nombre del host</span><input autoFocus required maxLength={160} disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label><label className="field"><span>Grupo</span><select disabled={busy} value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">Sin grupo</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><p className="field-help">Próxima conexión: {connectionTargetLabel(effective.host)} · {effective.identity ? `Identidad ${effective.identity.name}` : effective.host.authMethod === "private_key" ? "Clave privada propia" : "Contraseña propia"}</p><p className="field-help">Las sesiones abiertas se conservarán.</p>{error && <p className="form-error" role="alert">{error}</p>}</div>
    <footer className="modal-footer"><button className="button secondary" type="button" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" type="submit" disabled={busy}><Save size={15} />{busy ? "Guardando…" : "Guardar host"}</button></footer>
  </form></div>;
}
