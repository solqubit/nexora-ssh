import { useEffect, useRef, useState } from "react";
import { Network, Plus, Pencil, Play, Square, Trash2, X, Save, ShieldCheck } from "lucide-react";
import { createId } from "../data";
import { useAppStore } from "../store/appStore";
import { listTunnels, startTunnel, stopTunnel, stopAllTunnels, trustSshHostKey } from "../lib/desktop";
import { tunnelProfileSchema, tunnelListenIsLoopback } from "../lib/productivityValidation";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { Disclosure } from "./Disclosure";
import type { Host, TunnelProfile, TunnelState } from "../types";

const labels = { local: "Local", remote: "Remoto", socks: "SOCKS5" };
const statusLabels = { connecting: "Conectando", active: "Activo", stopping: "Cerrando", stopped: "Detenido", trust_required: "Verificar servidor", error: "Error" };
const endpoint = (address: string, port: number) => `${address.includes(":") ? `[${address}]` : address}:${port || "automático"}`;
const running = (state?: TunnelState) => Boolean(state && ["active", "connecting", "stopping"].includes(state.status));

export function TunnelManager({ vaultId, keepaliveSeconds }: { vaultId: string; keepaliveSeconds: number }) {
  const app = useAppStore(); const hosts = app.snapshot.hosts.filter(host => host.vaultId === vaultId && host.protocol !== "telnet");
  const profiles = (app.snapshot.productivity?.tunnels ?? []).filter(profile => hosts.some(host => host.id === profile.hostId));
  const [states, setStates] = useState<TunnelState[]>([]), [editing, setEditing] = useState<TunnelProfile | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null), [confirm, setConfirm] = useState<{ kind: "delete" | "expose"; profile: TunnelProfile } | null>(null), [trust, setTrust] = useState<TunnelState | null>(null);
  const busyRef = useRef(false), mounted = useRef(true), refreshing = useRef(false);
  async function refresh() {
    if (refreshing.current) return; refreshing.current = true;
    try { const next = await listTunnels(); if (mounted.current) setStates(next); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { refreshing.current = false; }
  }
  useEffect(() => { mounted.current = true; void refresh(); const timer = window.setInterval(() => void refresh(), 1500); return () => { mounted.current = false; window.clearInterval(timer); }; }, []);
  async function action(id: string, operation: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(id); setError("");
    try { await operation(); await refresh(); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  }
  const begin = (profile: TunnelProfile) => {
    if (!tunnelListenIsLoopback(profile.listenAddress)) setConfirm({ kind: "expose", profile });
    else void action(profile.id, () => startTunnel(profile.id, keepaliveSeconds));
  };
  return <section className="productivity-panel tunnel-manager"><header><div><h1>Túneles SSH</h1></div><div className="tunnel-header-actions"><button className="button secondary" disabled={busy !== null || !states.some(running)} onClick={() => void action("all", stopAllTunnels)}><Square size={14} />Detener todos</button><button className="button primary" disabled={!hosts.length || busy !== null} onClick={() => setEditing({ id: createId(), hostId: hosts[0].id, name: "", kind: "local", listenAddress: "127.0.0.1", listenPort: 8080, targetAddress: "127.0.0.1", targetPort: 80, updatedAt: new Date().toISOString() })}><Plus size={16} />Nuevo túnel</button></div></header>
    {profiles.length > 0 && <p className="field-help">Cerrar una terminal no detiene sus túneles.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="productivity-cards">{profiles.map(profile => {
      const state = states.find(item => item.profile.id === profile.id); const active = running(state); const host = hosts.find(host => host.id === profile.hostId)!; const port = active ? state?.listenPort ?? profile.listenPort : profile.listenPort;
      return <article key={profile.id} aria-label={`Túnel ${profile.name}`}><div className="tunnel-card-heading"><Network size={23} /><span className={`tunnel-status ${state?.status ?? "stopped"}`} role="status">{statusLabels[state?.status ?? "stopped"]}</span></div><small>{labels[profile.kind]} · {host.name}</small><h2>{profile.name}</h2><p className="tunnel-route">{profile.kind === "remote" ? "Servidor" : "Este equipo"} · {endpoint(profile.listenAddress, port)}<br />{profile.kind === "socks" ? "→ Destino elegido por tu aplicación" : `→ ${profile.kind === "remote" ? "Este equipo" : "Desde el servidor"} · ${endpoint(profile.targetAddress!, profile.targetPort!)}`}</p>
        {state?.message && <p>{state.message}</p>}{state?.lastError && <p className="form-error">Última conexión: {state.lastError}</p>}
        <footer>{active ? <button className="button secondary" disabled={busy !== null || state?.status === "stopping"} onClick={() => void action(profile.id, () => stopTunnel(profile.id))}><Square size={14} />{state?.status === "connecting" ? "Cancelar" : "Detener"}</button> : <button className="button secondary" disabled={busy !== null} onClick={() => begin(profile)}><Play size={14} />Iniciar</button>}
          {state?.trust && <button className="button secondary" disabled={busy !== null} onClick={() => setTrust(state)}><ShieldCheck size={14} />Revisar huella</button>}
          <button className="icon-button" disabled={active || busy !== null} aria-label={`Editar túnel ${profile.name}`} onClick={() => setEditing(profile)}><Pencil size={16} /></button><button className="icon-button" disabled={busy !== null} aria-label={`Eliminar túnel ${profile.name}`} onClick={() => setConfirm({ kind: "delete", profile })}><Trash2 size={16} /></button></footer></article>;
    })}</div>
    {!profiles.length && <div className="productivity-empty"><Network size={36} /><h2>Un servicio remoto, a tu alcance</h2><p>{hosts.length ? "Crea un túnel local para una base de datos, uno remoto para un servicio de tu equipo o un proxy SOCKS5 para tus aplicaciones." : "Guarda un host SSH para crear tu primer túnel."}</p></div>}
    {editing && <TunnelEditor profile={editing} hosts={hosts} onClose={() => setEditing(null)} onSave={async profile => { await app.updateProductivity(current => ({ ...current, tunnels: [...(current.tunnels ?? []).filter(item => item.id !== profile.id), profile] })); setEditing(null); }} />}
    {confirm && <TunnelActionDialog title={confirm.kind === "delete" ? `Eliminar ${confirm.profile.name}` : "Permitir conexiones desde otros equipos"} onClose={() => setConfirm(null)} onConfirm={async () => {
      if (confirm.kind === "delete") { await stopTunnel(confirm.profile.id); await app.updateProductivity(current => ({ ...current, tunnels: (current.tunnels ?? []).filter(item => item.id !== confirm.profile.id) })); }
      else await startTunnel(confirm.profile.id, keepaliveSeconds);
      setConfirm(null); await refresh();
    }} label={confirm.kind === "delete" ? "Detener y eliminar" : "Iniciar con esta escucha"}><p>{confirm.kind === "delete" ? "Se cerrarán sus conexiones y se retirará el perfil guardado." : `El túnel escuchará en ${endpoint(confirm.profile.listenAddress, confirm.profile.listenPort)}. Otros equipos podrían acceder al servicio si la red y el firewall lo permiten. En un túnel remoto, la escucha también depende de GatewayPorts en el servidor.`}</p></TunnelActionDialog>}
    {trust?.trust && <TunnelActionDialog title={trust.trust.kind === "changed" ? "La identidad del servidor cambió" : "Verificar servidor SSH"} label={trust.trust.kind === "changed" ? "Reemplazar clave e iniciar" : "Confiar e iniciar"} allowConfirm={Boolean(trust.trust.challengeId)} onClose={() => setTrust(null)} onConfirm={async () => {
      const known = await trustSshHostKey(trust.trust!.hostId, trust.trust!.challengeId, trust.trust!.kind === "changed"); app.rememberKnownHost(known); await stopTunnel(trust.profile.id); await startTunnel(trust.profile.id, keepaliveSeconds); setTrust(null); await refresh();
    }}><p>{trust.trust.address}</p><p>Algoritmo: {trust.trust.algorithm}</p><code className="tunnel-fingerprint">{trust.trust.fingerprint}</code><p>{trust.trust.kind === "changed" ? "Comprueba el cambio por un canal de confianza. La conexión permanece bloqueada." : "Compara esta huella con la del servidor antes de confiar. La verificación se aplica a este servidor de la ruta."}</p></TunnelActionDialog>}
  </section>;
}

function TunnelEditor({ profile, hosts, onClose, onSave }: { profile: TunnelProfile; hosts: Host[]; onClose: () => void; onSave: (profile: TunnelProfile) => Promise<void> }) {
  const [draft, setDraft] = useState(profile), [error, setError] = useState(""), [busy, setBusy] = useState(false), [discard, setDiscard] = useState(false); const busyRef = useRef(false);
  const close = () => { if (busyRef.current) return; if (JSON.stringify(profile) !== JSON.stringify(draft)) setDiscard(true); else onClose(); };
  const ref = useDialogFocus<HTMLFormElement>(close, busy || discard);
  const help = draft.kind === "local" ? "Escucha en tu equipo y abre el destino desde el servidor SSH." : draft.kind === "remote" ? "Escucha en el servidor SSH y abre el destino desde tu equipo." : "Proxy SOCKS5 CONNECT para TCP. Los nombres se resuelven desde el servidor SSH. Escucha solo en loopback y no admite UDP.";
  return <div className="modal-backdrop"><form ref={ref} className="modal" role="dialog" aria-modal="true" aria-label="Configurar túnel SSH" tabIndex={-1} onSubmit={event => {
    event.preventDefault(); if (busyRef.current) return;
    const parsed = tunnelProfileSchema.safeParse({ ...draft, name: draft.name.trim(), listenAddress: draft.listenAddress.trim(), targetAddress: draft.targetAddress?.trim() ?? null, updatedAt: new Date().toISOString() });
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    busyRef.current = true; setBusy(true); setError(""); void onSave(parsed.data).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { busyRef.current = false; setBusy(false); });
  }}><header className="modal-header"><Network size={22} /><h2>Configurar túnel SSH</h2><button type="button" className="icon-button" disabled={busy} aria-label="Cerrar configuración de túnel" onClick={close}><X size={18} /></button></header><div className="modal-body"><fieldset className="snippet-form-fields" disabled={busy}>
    <label className="field"><span>Nombre del túnel</span><input autoFocus required maxLength={160} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
    <label className="field"><span>Host SSH</span><select value={draft.hostId} onChange={event => setDraft({ ...draft, hostId: event.target.value })}>{hosts.map(host => <option key={host.id} value={host.id}>{host.name} · {host.address}</option>)}</select></label>
    <label className="field"><span>Tipo de túnel</span><select value={draft.kind} onChange={event => { const kind = event.target.value as TunnelProfile["kind"]; setDraft({ ...draft, kind, listenAddress: kind === "socks" ? "127.0.0.1" : draft.listenAddress, targetAddress: kind === "socks" ? null : draft.targetAddress ?? "127.0.0.1", targetPort: kind === "socks" ? null : draft.targetPort ?? 80 }); }}><option value="local">Local</option><option value="remote">Remoto</option><option value="socks">SOCKS5</option></select></label><p className="field-help">{help}</p>
    <label className="field"><span>Puerto de escucha</span><input required type="number" min={0} max={65535} value={Number.isNaN(draft.listenPort) ? "" : draft.listenPort} onChange={event => setDraft({ ...draft, listenPort: event.target.valueAsNumber })} /><small className="field-help">0 elige un puerto libre.</small></label>
    {draft.kind !== "socks" && <div className="tunnel-address-fields"><label className="field"><span>Dirección de destino</span><input required maxLength={253} value={draft.targetAddress ?? ""} onChange={event => setDraft({ ...draft, targetAddress: event.target.value })} /></label><label className="field"><span>Puerto de destino</span><input required type="number" min={1} max={65535} value={draft.targetPort === null || Number.isNaN(draft.targetPort) ? "" : draft.targetPort} onChange={event => setDraft({ ...draft, targetPort: event.target.valueAsNumber })} /></label></div>}
    <Disclosure title="Avanzado" defaultOpen={profile.listenAddress !== "127.0.0.1" && profile.listenAddress !== "::1"}><label className="field"><span>Dirección de escucha</span><input required value={draft.listenAddress} placeholder="127.0.0.1 o ::1" onChange={event => setDraft({ ...draft, listenAddress: event.target.value })} /></label></Disclosure>
    {!tunnelListenIsLoopback(draft.listenAddress) && <p className="field-help">Esta escucha puede admitir conexiones desde otros equipos; se pedirá confirmación al iniciar.</p>}
    <p className="field-help">Guardar no inicia el túnel.</p></fieldset>{error && <p className="form-error" role="alert">{error}</p>}{discard && <div className="broadcast-notice"><p>Hay cambios sin guardar.</p><button type="button" className="button secondary" onClick={() => setDiscard(false)}>Seguir editando</button><button type="button" className="button danger" onClick={onClose}>Descartar cambios</button></div>}</div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancelar</button><button className="button primary" disabled={busy}><Save size={15} />{busy ? "Guardando…" : "Guardar túnel"}</button></footer></form></div>;
}
function TunnelActionDialog({ title, label, children, allowConfirm = true, onConfirm, onClose }: { title: string; label: string; children: React.ReactNode; allowConfirm?: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const busyRef = useRef(false); const ref = useDialogFocus<HTMLDivElement>(() => { if (!busyRef.current) onClose(); }, busy);
  return <div className="modal-backdrop"><div ref={ref} className="modal" role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}><header className="modal-header"><ShieldCheck size={22} /><h2>{title}</h2></header><div className="modal-body">{children}{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>{allowConfirm ? "Cancelar" : "Cerrar"}</button>{allowConfirm && <button className="button primary" disabled={busy} onClick={() => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); void onConfirm().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => { busyRef.current = false; setBusy(false); }); }}>{busy ? "Espera…" : label}</button>}</footer></div></div>;
}
