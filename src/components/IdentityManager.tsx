import { useEffect, useRef, useState } from "react";
import { KeyRound, Plus, Pencil, Trash2, X, Save, FileUp, ShieldCheck } from "lucide-react";
import { createId } from "../data";
import { useAppStore } from "../store/appStore";
import { getIdentityStatus } from "../lib/desktop";
import { useDialogFocus } from "../hooks/useDialogFocus";
import type { Identity, SecretStatus, SecretUpdate } from "../types";
export function IdentityManager({ vaultId }: { vaultId: string }) {
  const app = useAppStore(); const [editing, setEditing] = useState<Identity | null>(null); const [deleting, setDeleting] = useState<Identity | null>(null);
  const data = app.snapshot.productivity;
  const identities = (data?.identities ?? []).filter(identity => identity.vaultId === vaultId);
  const createIdentity = () => setEditing({ id: createId(), vaultId, name: "", username: "", authMethod: "password", updatedAt: new Date().toISOString() });
  return <section className="productivity-panel"><header><div><h1>Identidades</h1></div><button className="button primary" onClick={createIdentity}><Plus size={16} />Nueva identidad</button></header>
    <div className="productivity-cards">{identities.map(identity => {
      const uses = (data?.connectionProfiles ?? []).filter(profile => profile.identityId === identity.id).length + (data?.groupDefaults ?? []).filter(group => group.identityId === identity.id).length;
      return <article key={identity.id}><KeyRound size={24} /><h2>{identity.name}</h2><p>{identity.username || "Usuario definido en cada host"}</p><small>{identity.authMethod === "password" ? "Contraseña" : "Clave privada"} · {uses} asignaciones</small><footer><button className="button secondary" onClick={() => setEditing(identity)}><Pencil size={14} />Editar</button><button className="icon-button" disabled={uses > 0} title={uses ? "Retira las asignaciones de hosts y grupos antes de eliminar" : "Eliminar identidad"} aria-label={`Eliminar identidad ${identity.name}`} onClick={() => setDeleting(identity)}><Trash2 size={16} /></button></footer></article>;
    })}</div>
    {!identities.length && <div className="productivity-empty"><KeyRound size={32} /><h2>Configura una vez, úsala en varios hosts</h2><p>Guarda un acceso y asígnalo a tus servidores o grupos. Podrás actualizar sus credenciales desde un solo lugar.</p><button className="button secondary" onClick={createIdentity}>Crear mi primera identidad</button></div>}
    {editing && <IdentityEditor key={editing.id} identity={editing} onClose={() => setEditing(null)} onSave={async (identity, update) => { await app.upsertIdentity(identity, update); setEditing(null); }} />}
    {deleting && <DeleteIdentityDialog identity={deleting} onClose={() => setDeleting(null)} onDelete={async () => { await app.updateProductivity(current => ({ ...current, identities: current.identities?.filter(identity => identity.id !== deleting.id) })); setDeleting(null); }} />}
  </section>;
}
function IdentityEditor({ identity, onClose, onSave }: { identity: Identity; onClose: () => void; onSave: (identity: Identity, update: SecretUpdate) => Promise<void> }) {
  const [draft, setDraft] = useState<Identity>({ ...identity, authMethod: identity.authMethod === "system_agent" ? "private_key" as const : identity.authMethod }), [password, setPassword] = useState(""), [key, setKey] = useState(""), [keyName, setKeyName] = useState<string | null>(null), [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<SecretStatus | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [discard, setDiscard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), busyRef = useRef(false);
  const fileGeneration = useRef(0);
  useEffect(() => () => { fileGeneration.current += 1; }, []);
  const existing = useAppStore.getState().snapshot.productivity?.identities?.some(item => item.id === identity.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(identity) || Boolean(password || key || passphrase);
  const requestClose = () => { if (busyRef.current) return; if (dirty) setDiscard(true); else onClose(); };
  const ref = useDialogFocus<HTMLFormElement>(requestClose, busy || discard);
  useEffect(() => { let active = true; if (existing) void getIdentityStatus(identity.id).then(value => { if (active) setStatus(value); }, reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [identity.id, existing]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busyRef.current) return;
    if (!draft.name.trim()) { setError("Escribe un nombre."); return; }
    if (draft.authMethod === "password" && !password && !status?.hasPassword) { setError("Introduce la contraseña de esta identidad."); return; }
    if (draft.authMethod === "private_key" && !key && !status?.hasPrivateKey) { setError("Carga una clave privada OpenSSH o PEM."); return; }
    busyRef.current = true; setBusy(true); setError("");
    try { await onSave({ ...draft, name: draft.name.trim(), username: draft.username.trim(), updatedAt: new Date().toISOString() }, { password: draft.authMethod === "password" ? password || null : null, privateKey: draft.authMethod === "private_key" ? key || null : null, privateKeyName: keyName, keyPassphrase: draft.authMethod === "private_key" ? passphrase || null : null, clearPassword: draft.authMethod !== "password", clearPrivateKey: draft.authMethod !== "private_key" || Boolean(key) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const readKey = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return; event.target.value = "";
    const generation = ++fileGeneration.current;
    try { if (file.size > 512 * 1024) throw new Error("La clave supera el límite de 512 KB."); const content = await file.text(); if (generation !== fileGeneration.current) return; if (!content.includes("PRIVATE KEY-----") || content.includes("PuTTY-User-Key-File")) throw new Error("Selecciona una clave privada OpenSSH o PEM."); setKey(content); setKeyName(file.name); setError(""); }
    catch (reason) { if (generation === fileGeneration.current) setError(String(reason)); }
  };
  return <div className="modal-backdrop"><form ref={ref} className="modal identity-editor" role="dialog" aria-modal="true" aria-label="Editar identidad" tabIndex={-1} onSubmit={event => void submit(event)}><header className="modal-header"><KeyRound size={22} /><div><h2>{existing ? "Editar identidad" : "Nueva identidad"}</h2><p>Los cambios se aplican a las próximas conexiones de sus hosts.</p></div><button disabled={busy} type="button" className="icon-button" aria-label="Cerrar identidad" onClick={requestClose}><X size={18} /></button></header><div className="modal-body"><fieldset disabled={busy} className="snippet-form-fields">
    <label className="field"><span>Nombre</span><input autoFocus required maxLength={160} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Administrador del laboratorio" /></label><label className="field"><span>Usuario predeterminado</span><input maxLength={256} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} placeholder="ubuntu" /></label><label className="field"><span>Autenticación</span><select value={draft.authMethod} onChange={event => setDraft({ ...draft, authMethod: event.target.value as Identity["authMethod"] })}><option value="password">Contraseña</option><option value="private_key">Clave privada</option></select></label>
    {draft.authMethod === "password" ? <label className="field"><span>Contraseña</span><input type="password" maxLength={65536} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={status?.hasPassword ? "Guardada · deja vacío para conservarla" : "Contraseña SSH"} /></label> : <><div className="key-editor-header"><ShieldCheck size={16} /><span>{keyName ?? status?.privateKeyName ?? "Clave OpenSSH/PEM"}</span><button className="button secondary" type="button" onClick={() => fileRef.current?.click()}><FileUp size={14} />Cargar</button></div><input ref={fileRef} type="file" className="visually-hidden" onChange={event => void readKey(event)} /><label className="field"><span>Clave privada</span><textarea className="key-content-editor" maxLength={524288} value={key} onChange={event => { setKey(event.target.value); setKeyName("clave pegada"); }} placeholder={status?.hasPrivateKey ? "Guardada · deja vacío para conservarla" : "-----BEGIN OPENSSH PRIVATE KEY-----"} spellCheck={false} /></label><label className="field"><span>Passphrase opcional</span><input type="password" maxLength={65536} autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder={key ? "Passphrase de la nueva clave · vacío si no tiene" : status?.hasKeyPassphrase ? "Guardada · deja vacío para conservarla" : "Passphrase"} /></label></>}
    </fieldset>{error && <p className="form-error" role="alert">{error}</p>}{discard && <div className="broadcast-notice"><p>Hay cambios sin guardar.</p><button type="button" className="button secondary" onClick={() => setDiscard(false)}>Seguir editando</button><button type="button" className="button danger" onClick={onClose}>Descartar cambios</button></div>}</div><footer className="modal-footer"><button disabled={busy} type="button" className="button secondary" onClick={requestClose}>Cancelar</button><button disabled={busy} className="button primary"><Save size={15} />{busy ? "Guardando…" : "Guardar identidad"}</button></footer></form></div>;
}
function DeleteIdentityDialog({ identity, onClose, onDelete }: { identity: Identity; onClose: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const busyRef = useRef(false); const ref = useDialogFocus<HTMLDivElement>(onClose, busy);
  return <div className="modal-backdrop"><div ref={ref} className="modal small-modal" role="alertdialog" aria-modal="true" aria-label="Eliminar identidad" tabIndex={-1}><header className="modal-header"><h2>Eliminar identidad</h2></header><div className="modal-body"><p>Se eliminarán “{identity.name}” y sus credenciales guardadas.</p>{error && <p role="alert" className="form-error">{error}</p>}</div><footer className="modal-footer"><button disabled={busy} className="button secondary" onClick={onClose}>Cancelar</button><button disabled={busy} className="button danger" onClick={() => { if (busyRef.current) return; busyRef.current = true; setBusy(true); void onDelete().catch(reason => setError(String(reason))).finally(() => { busyRef.current = false; setBusy(false); }); }}>Eliminar identidad</button></footer></div></div>;
}
