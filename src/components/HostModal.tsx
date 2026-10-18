import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Eye, EyeOff, FileKey2, FileUp, KeyRound, LockKeyhole, Network, ShieldCheck, TerminalSquare, Save, RotateCcw, X } from "lucide-react";
import { COLORS, emptyHostDraft } from "../data";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useAppStore } from "../store/appStore";
import { emptyConnectionProfile, resolveConnectionProfile } from "../lib/connectionProfile";
import { uniqueLabels } from "../lib/hostFilters";
import { connectionTargetLabel } from "../lib/sessionTarget";
import { getSecretStatus, revealHostPassword } from "../lib/desktop";
import type { Host, ConnectionProfile, HostDraft, HostGroup, SecretStatus, SecretUpdate } from "../types";

export interface HostModalProps {
  inline?: boolean;
  onOpen?: () => void;
  onDiscard?: () => void;
  secondaryActions?: React.ReactNode;
  vaultId: string;
  selectedGroupId: string | null;
  groups: HostGroup[];
  initialDraft?: Partial<HostDraft>;
  defaultKeepalive?: number;
  quick?: boolean;
  host?: Host;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onSave: (draft: HostDraft, secrets: SecretUpdate, connectAfter?: boolean, connection?: Omit<ConnectionProfile, "hostId">, temporary?: boolean) => Promise<void>;
}

export function HostModal({ vaultId, selectedGroupId, groups, initialDraft, defaultKeepalive = 30, quick = false, host, onDirtyChange, onBusyChange, onClose, onSave, inline = false, onOpen, onDiscard, secondaryActions }: HostModalProps) {
  const initial = useRef<HostDraft>({ ...emptyHostDraft(vaultId, selectedGroupId), ...host, ...initialDraft, authMethod: (initialDraft?.authMethod ?? host?.authMethod) === "system_agent" ? "private_key" : initialDraft?.authMethod ?? host?.authMethod ?? "password" }).current;
  const [draft, setDraft] = useState(initial);
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const snapshot = useAppStore(state => state.snapshot);
  const identities = (snapshot.productivity?.identities ?? []).filter(identity => identity.vaultId === vaultId);
  const initialConnection = useRef(host ? resolveConnectionProfile(snapshot, host).profile : emptyConnectionProfile("draft")).current;
  const [connection, setConnection] = useState(initialConnection);
  const previewHost: Host = { ...draft, id: host?.id ?? "draft", createdAt: host?.createdAt ?? "now", updatedAt: host?.updatedAt ?? "now" };
  const effective = resolveConnectionProfile({ ...snapshot, productivity: { workspaces: [], snippets: [], ...snapshot.productivity, connectionProfiles: [connection] } }, previewHost, defaultKeepalive);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [keyPassphraseVisible, setKeyPassphraseVisible] = useState(false);
  const [password, setPassword] = useState("");
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [revealingPassword, setRevealingPassword] = useState(false);
  const revealGeneration = useRef(0), revealTimer = useRef<number | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const forgetRevealed = () => {
    revealGeneration.current += 1;
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    revealTimer.current = null; setRevealedPassword(null); setPasswordVisible(false); setRevealingPassword(false);
  };
  useEffect(() => () => { revealGeneration.current += 1; if (revealTimer.current !== null) window.clearTimeout(revealTimer.current); }, []);
  const [privateKeyContent, setPrivateKeyContent] = useState("");
  const [privateKeyName, setPrivateKeyName] = useState<string | null>(null);
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null);
  const [loadingSecrets, setLoadingSecrets] = useState(Boolean(host));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const submitRef = useRef(false);
  const quickButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileGeneration = useRef(0);
  useEffect(() => () => { fileGeneration.current += 1; }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
    || tagsText !== initial.tags.join(", ")
    || JSON.stringify(connection) !== JSON.stringify(initialConnection)
    || Boolean(password)
    || Boolean(privateKeyContent)
    || Boolean(keyPassphrase);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);
  const requestClose = () => { if (!submitRef.current) { if (dirty) setDiscardPrompt(true); else onClose(); } };
  const dialogRef = useDialogFocus<HTMLFormElement>(requestClose, saving || discardPrompt, !inline);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!host) return;
    let live = true;
    void getSecretStatus(host.id).then(status => { if (live) setSecretStatus(status); }, reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (live) setLoadingSecrets(false); });
    return () => { live = false; };
  }, [host?.id]);
  const telnet = draft.protocol === "telnet";
  const avatarInitial = draft.name.trim().slice(0, 2).toUpperCase();
  const hasTarget = Boolean(draft.address.trim());
  const targetPreview = hasTarget
    ? connectionTargetLabel({ ...effective.host, address: draft.address.trim(), username: effective.host.username.trim() })
    : "Datos de conexión";

  useEffect(() => {
    if (!dirty) return;
    const protectChanges = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectChanges);
    return () => window.removeEventListener("beforeunload", protectChanges);
  }, [dirty]);

  const update = <K extends keyof HostDraft>(key: K, value: HostDraft[K]) => setDraft((state) => ({ ...state, [key]: value }));

  async function loadPrivateKey(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    const generation = ++fileGeneration.current;
    try {
      if (file.size > 512 * 1024) throw new Error("La clave privada supera el límite de 512 KB.");
      const content = await file.text();
      if (generation !== fileGeneration.current) return;
      if (!looksLikePrivateKey(content)) throw new Error(content.includes("PuTTY-User-Key-File-") ? "El formato PPK todavía no es compatible. Expórtalo como OpenSSH desde PuTTYgen." : "El archivo no parece contener una clave privada OpenSSH o PEM.");
      setPrivateKeyContent(content.trim()); setPrivateKeyName(file.name); setError("");
    } catch (reason) { if (generation === fileGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function togglePassword() {
    if (passwordVisible || revealedPassword !== null) { forgetRevealed(); return; }
    if (!inline || password || !host || !secretStatus?.hasPassword) { setPasswordVisible(true); return; }
    if (revealingPassword) return;
    const generation = ++revealGeneration.current;
    setRevealingPassword(true); setError("");
    try {
      const value = await revealHostPassword(host.id);
      if (generation !== revealGeneration.current) return;
      if (value === null) { setError("Este host no tiene una contraseña guardada."); return; }
      setRevealedPassword(value); setPasswordVisible(true);
      revealTimer.current = window.setTimeout(forgetRevealed, 20_000);
    } catch (reason) { if (generation === revealGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation === revealGeneration.current) setRevealingPassword(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitRef.current || loadingSecrets) return;
    const connectAfter = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "connect";
    if (inline && !dirty) { if (connectAfter) onOpen?.(); return; }
    forgetRevealed();
    if (!draft.name.trim() || !draft.address.trim()) {
      setError("Escribe un nombre y una dirección para el host.");
      return;
    }
    if (!telnet && !effective.host.username.trim()) {
      setError("Escribe el usuario SSH para este host.");
      return;
    }
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
      setError("El puerto debe estar entre 1 y 65535.");
      return;
    }
    if (!telnet && !effective.identity && draft.authMethod === "password" && !password && !secretStatus?.hasPassword) {
      setError("Escribe la contraseña SSH para este host.");
      return;
    }
    if (!telnet && !effective.identity && draft.authMethod === "private_key" && !privateKeyContent && !secretStatus?.hasPrivateKey) {
      setError("Carga o pega el contenido de una clave privada.");
      return;
    }
    if (!telnet && !effective.identity && draft.authMethod === "private_key" && privateKeyContent && !looksLikePrivateKey(privateKeyContent)) {
      setError("El contenido no parece una clave privada OpenSSH o PEM válida.");
      return;
    }
    setSaving(true);
    submitRef.current = true;
    try {
      await onSave(
        { ...draft, favorite: host?.favorite ?? draft.favorite, tags: uniqueLabels(tagsText.split(",")), keyPath: null, name: draft.name.trim(), address: draft.address.trim(), username: draft.username.trim() },
        {
          password: !effective.identity && draft.authMethod === "password" ? password || null : null,
          privateKey: !effective.identity && draft.authMethod === "private_key" ? privateKeyContent || null : null,
          privateKeyName: !effective.identity && draft.authMethod === "private_key" ? privateKeyName : null,
          keyPassphrase: !effective.identity && draft.authMethod === "private_key" ? keyPassphrase || null : null,
          clearPassword: !effective.identity && draft.authMethod !== "password",
          clearPrivateKey: !effective.identity && draft.authMethod !== "private_key",
        },
        quick || (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "connect",
        connection,
        quick && (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "connect",
      );
      if (!inline) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el host.");
    } finally {
      submitRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
    <div className={inline ? "host-inline-frame" : "modal-backdrop"} role={inline ? undefined : "presentation"} onMouseDown={(event) => !inline && event.target === event.currentTarget && requestClose()}>
      <form ref={dialogRef} className={inline ? "host-inline-editor" : "modal host-modal"} role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : true} aria-label={inline ? `Editar conexión de ${host?.name}` : undefined} aria-labelledby={inline ? undefined : "host-dialog-title"} tabIndex={-1} onSubmit={submit} onKeyDown={event => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing || !(event.target instanceof HTMLInputElement) || !["text", "password", "number"].includes(event.target.type)) return;
        if (inline) { event.preventDefault(); if (dirty && saveButtonRef.current) dialogRef.current?.requestSubmit(saveButtonRef.current); }
        else if (quick) { event.preventDefault(); if (quickButtonRef.current) dialogRef.current?.requestSubmit(quickButtonRef.current); }
      }}>
        {inline && <div className="host-inline-heading"><span>Detalles del host</span><button className="icon-button" type="button" disabled={saving} onClick={onClose} aria-label="Cerrar detalles"><X size={17} /></button></div>}
        <header className={inline ? "host-inline-hero" : "modal-header host-modal-header"}>
          <div className="host-modal-avatar" style={{ background: draft.color }}>{avatarInitial || <Network size={17} />}</div>
          <div>
            <h2 id={inline ? undefined : "host-dialog-title"}>{inline ? <input aria-label="Nombre" value={draft.name} disabled={saving || loadingSecrets} onChange={event => update("name", event.target.value)} placeholder="Nombre del host" /> : host ? "Editar host" : quick ? "Conexión rápida" : "Nuevo host"}</h2>
            <p className={hasTarget ? "host-modal-target" : undefined}>{targetPreview}</p>
          </div>
          {!inline && <button className="icon-button modal-close" type="button" disabled={saving} onClick={requestClose} aria-label="Cerrar"><X size={18} /></button>}
        </header>

        {inline && <div className="host-inline-connect"><button className="button primary" type="submit" value="connect" disabled={saving || loadingSecrets}><TerminalSquare size={16} />{saving ? "Guardando…" : "Conectar"}</button></div>}
        <div className={inline ? "host-inline-body" : "modal-body host-modal-body"}>
          <fieldset className="host-editor-fields" disabled={saving || loadingSecrets}>
          {quick && <p className="field-help">Puedes conectar sin guardar y guardar el host después.</p>}
          <div className="hostform">
            {inline && <h3>Conexión</h3>}
            <label className="field"><span>Protocolo</span><select value={draft.protocol ?? "ssh"} onChange={event => {
              const protocol = event.target.value as "ssh" | "telnet";
              setDraft(current => ({ ...current, protocol, port: current.port === 22 || current.port === 23 ? protocol === "telnet" ? 23 : 22 : current.port, authMethod: protocol === "telnet" ? "password" : current.authMethod }));
              setConnection(current => ({ ...current, identityId: null, inheritIdentity: false, jumpHostId: null }));
            }}><option value="ssh">SSH</option><option value="telnet">TELNET</option></select></label>
            {telnet && <p className="field-help">Telnet transmite sin cifrado. El usuario y la contraseña son opcionales; también puedes iniciar sesión desde la terminal.</p>}
            {!inline && <label className="field">
              <span>Nombre</span>
              <input autoFocus value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="Servidor de producción" />
            </label>}
            <div className="hostform-row">
              <label className="field">
                <span>Dirección o IP</span>
                <input value={draft.address} onChange={(event) => update("address", event.target.value)} placeholder="192.168.1.20 o server.local" spellCheck={false} />
              </label>
              <label className="field narrow">
                <span>Puerto</span>
                <input type="number" min={1} max={65535} value={draft.port} onChange={(event) => update("port", Number(event.target.value))} />
              </label>
            </div>
          </div>

          <div className="hostform-auth">
            <span className="hostform-label">{inline ? "Credenciales" : "Acceso al servidor"}</span>
            <div className="hostform-row"><label className="field"><span>Usuario</span><input value={draft.username} onChange={(event) => update("username", event.target.value)} placeholder="root, ubuntu…" autoComplete="off" /></label>
            {!telnet && <label className="field"><span>Identidad</span><select value={effective.identity?.id ?? connection.identityId ?? ""} onChange={event => { const identity = identities.find(item => item.id === event.target.value); setConnection({ ...connection, identityId: identity?.id ?? null, inheritIdentity: false, inheritUsername: false }); if (identity?.username) update("username", identity.username); }}><option value="">Credenciales de este host</option>{identities.filter(identity => identity.authMethod !== "system_agent").map(identity => <option key={identity.id} value={identity.id}>{identity.name}</option>)}</select></label>}</div>
            {!telnet && effective.identity ? <div className="broadcast-notice"><KeyRound size={16} /><p>Acceso: {effective.identity.name}</p></div> : <>
            {!telnet && <div className="seg" role="group" aria-label="Método de autenticación">
              <button className={draft.authMethod === "password" ? "active" : ""} aria-pressed={draft.authMethod === "password"} type="button" onClick={() => update("authMethod", "password")}><LockKeyhole size={15} /> Contraseña</button>
              <button className={draft.authMethod === "private_key" ? "active" : ""} aria-pressed={draft.authMethod === "private_key"} type="button" onClick={() => update("authMethod", "private_key")}><KeyRound size={15} /> Clave privada</button>
            </div>}
            {draft.authMethod === "password" && (
              <div className="secret-fields">
                <label className="field secret-input-field">
                  <span>{inline || telnet ? "Contraseña" : "Contraseña SSH"}</span>
                  <input type={passwordVisible ? "text" : "password"} value={password || revealedPassword || ""} onChange={(event) => { const value = event.target.value; forgetRevealed(); setPassword(value); }} placeholder={secretStatus?.hasPassword ? "Guardada · deja vacío para conservarla" : "Contraseña del servidor"} autoComplete="new-password" />
                  <button type="button" disabled={revealingPassword} onClick={() => void togglePassword()} aria-label={passwordVisible ? "Ocultar contraseña" : inline && secretStatus?.hasPassword && !password ? "Revelar contraseña" : "Mostrar contraseña"}>{passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </label>
              </div>
            )}
            {draft.authMethod === "private_key" && (
              <div className="secret-fields">
                <input ref={fileInputRef} className="visually-hidden" type="file" accept=".pem,.key,.openssh,.rsa" onChange={(event) => void loadPrivateKey(event)} />
                <div className="key-editor-header">
                  <div><FileKey2 size={16} /><span>Clave privada<small>{secretStatus?.hasPrivateKey ? secretStatus.privateKeyName ?? "Clave guardada" : "OpenSSH o PEM"}</small></span></div>
                  <button className="button secondary" type="button" onClick={() => fileInputRef.current?.click()}><FileUp size={15} /> Cargar archivo</button>
                </div>
                <textarea className="key-content-editor" aria-label="Clave privada" value={privateKeyContent} onChange={(event) => { setPrivateKeyContent(event.target.value); setPrivateKeyName(privateKeyName ?? "clave pegada"); }} placeholder={secretStatus?.hasPrivateKey ? "Guardada · deja vacío para conservarla" : "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"} rows={5} spellCheck={false} />
                {privateKeyContent && <div className="loaded-key"><ShieldCheck size={14} /><span>{privateKeyName ?? "Contenido pegado"}</span><small>{privateKeyContent.length.toLocaleString()} caracteres</small><button type="button" onClick={() => { setPrivateKeyContent(""); setPrivateKeyName(null); }}><X size={14} /></button></div>}
                <label className="field secret-input-field">
                  <span>Passphrase <small>· opcional</small></span>
                  <input type={keyPassphraseVisible ? "text" : "password"} value={keyPassphrase} onChange={(event) => setKeyPassphrase(event.target.value)} placeholder={secretStatus?.hasKeyPassphrase ? "Guardada · deja vacío para conservarla" : "Solo si la clave está cifrada"} autoComplete="new-password" />
                  <button type="button" onClick={() => setKeyPassphraseVisible(!keyPassphraseVisible)} aria-label={keyPassphraseVisible ? "Ocultar passphrase" : "Mostrar passphrase"}>{keyPassphraseVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                </label>
              </div>
            )}
            </>}
          </div>

          {inline && <h3>Organización</h3>}
          <label className="field"><span>Grupo</span><select value={draft.groupId ?? ""} onChange={(event) => update("groupId", event.target.value || null)}><option value="">Sin grupo</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
          <div className="hostform-appearance"><div className="field"><span>Color</span><div className="color-picker" role="group" aria-label="Color del host">{COLORS.map(color => <button type="button" key={color} className={`color-dot ${draft.color === color ? "selected" : ""}`} aria-pressed={draft.color === color} style={{ "--dot-color": color } as React.CSSProperties} onClick={() => update("color", color)} aria-label={`Usar color ${color}`} />)}</div></div><label className="field"><span>Etiquetas</span><input value={tagsText} onChange={event => setTagsText(event.target.value)} placeholder="producción, web…" /></label></div>
          <label className="field"><span>Notas</span><textarea value={draft.note} onChange={event => update("note", event.target.value)} rows={2} placeholder="Función del servidor…" /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          </fieldset>
        </div>

        {inline ? <footer className="host-inline-footer">
          <div className="host-inline-save"><button className="button secondary" type="button" disabled={saving || !dirty} onClick={() => { forgetRevealed(); onDiscard?.(); }}><RotateCcw size={14} />Descartar</button><button ref={saveButtonRef} className="button primary" type="submit" value="save" disabled={saving || loadingSecrets || !dirty}><Save size={14} />{saving ? "Guardando…" : "Guardar"}</button></div>
          <fieldset className="host-inline-secondary-fields" disabled={saving}>{secondaryActions}</fieldset>
        </footer> : <footer className="modal-footer">
          <button className="button secondary" type="button" disabled={saving} onClick={requestClose}>Cancelar</button>
          <button className={host ? "button primary" : "button secondary"} type="submit" value={quick ? "connect" : "save"} disabled={saving || loadingSecrets}>{host && saving ? "Guardando…" : quick ? "Guardar y conectar" : "Guardar"}</button>
          <button ref={quickButtonRef} className={host ? "button secondary" : "button primary"} type="submit" value={quick ? "temporary" : "connect"} disabled={saving || loadingSecrets}>{saving ? quick ? "Preparando…" : "Guardando…" : quick ? "Conectar sin guardar" : "Guardar y conectar"}</button>
        </footer>}
      </form>
    </div>
    {discardPrompt && <DiscardHostChangesDialog onCancel={() => setDiscardPrompt(false)} onDiscard={onClose} />}
    </>
  );
}

function DiscardHostChangesDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);
  return <div className="modal-backdrop nested-confirm-backdrop" role="presentation">
    <div ref={dialogRef} className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-host-title" tabIndex={-1}>
      <header className="modal-header"><div className="modal-icon danger"><AlertTriangle size={19} /></div><div><h2 id="discard-host-title">Descartar cambios</h2><p>La configuración todavía no se ha guardado.</p></div></header>
      <div className="modal-body confirm-copy"><p>Si cierras ahora, se perderán los datos que modificaste.</p></div>
      <footer className="modal-footer"><button className="button secondary" type="button" onClick={onCancel}>Seguir editando</button><button className="button danger" type="button" onClick={onDiscard}>Descartar cambios</button></footer>
    </div>
  </div>;
}

function looksLikePrivateKey(content: string): boolean {
  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
  ].some((marker) => content.includes(marker));
}
