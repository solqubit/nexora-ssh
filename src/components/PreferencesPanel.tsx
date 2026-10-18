import { LayoutGrid, List, Monitor, RefreshCw, Settings, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import { isAssignableShortcut, type AppPreferences } from "../lib/preferences";
import { TERMINAL_THEME_OPTIONS } from "../lib/terminalThemes";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { Disclosure } from "./Disclosure";

interface PreferencesPanelProps {
  preferences: AppPreferences;
  onChange: (changes: Partial<AppPreferences>) => void;
  onClose: () => void;
}

export function PreferencesPanel({ preferences, onChange, onClose }: PreferencesPanelProps) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const [shortcutError, setShortcutError] = useState("");
  return <div className="settings-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <aside ref={dialogRef} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
      <header><span className="settings-icon"><Settings size={19} /></span><div><h2 id="settings-title">Preferencias</h2></div><button className="icon-button" onClick={onClose} aria-label="Cerrar preferencias"><X size={18} /></button></header>
      <div className="settings-content">
        <section>
          <div className="settings-section-title"><Monitor size={15} /><strong>Interfaz</strong></div>
          <div className="settings-grid"><label className="wide"><span>Apariencia</span><select data-dialog-initial-focus value={preferences.interfaceTheme} onChange={event => onChange({ interfaceTheme: event.target.value as AppPreferences["interfaceTheme"] })}><option value="dark">Oscura</option><option value="light">Clara</option><option value="system">Sistema</option></select></label></div>
          <span className="settings-label">Tamaño de la interfaz</span>
          <div className="settings-view-toggle three-options" role="radiogroup" aria-label="Escala de la interfaz">{(["compact", "normal", "large"] as const).map(scale => <button key={scale} type="button" role="radio" aria-checked={preferences.uiScale === scale} className={preferences.uiScale === scale ? "active" : ""} onClick={() => onChange({ uiScale: scale })}>{scale === "compact" ? "Compacta" : scale === "normal" ? "Normal" : "Grande"}</button>)}</div>
          <span className="settings-label">Vista de hosts</span>
          <div className="settings-view-toggle"><button aria-pressed={preferences.hostViewMode === "grid"} className={preferences.hostViewMode === "grid" ? "active" : ""} onClick={() => onChange({ hostViewMode: "grid" })}><LayoutGrid size={15} />Tarjetas</button><button aria-pressed={preferences.hostViewMode === "list"} className={preferences.hostViewMode === "list" ? "active" : ""} onClick={() => onChange({ hostViewMode: "list" })}><List size={15} />Lista</button></div>
        </section>
        <section>
          <div className="settings-section-title"><TerminalSquare size={15} /><strong>Terminal</strong></div>
          <div className="settings-grid">
            <label className="wide"><span>Tema de la terminal</span><select value={preferences.terminalTheme} onChange={event => onChange({ terminalTheme: event.target.value as AppPreferences["terminalTheme"] })}>{TERMINAL_THEME_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label className="wide"><span>Tamaño de fuente</span><input type="range" min={10} max={24} value={preferences.terminalFontSize} onChange={event => onChange({ terminalFontSize: Number(event.target.value) })} /><output>{preferences.terminalFontSize}px</output></label>
          </div>
        </section>
        <section>
          <div className="settings-section-title"><RefreshCw size={15} /><strong>Conexión</strong></div>
          <SettingSwitch label="Reconectar automáticamente" checked={preferences.autoReconnect} onChange={autoReconnect => onChange({ autoReconnect })} />
        </section>
        <Disclosure title="Avanzado">
          <div className="settings-advanced-group"><h3>Accesibilidad</h3><SettingSwitch label="Reducir movimiento" checked={preferences.reduceMotion} onChange={reduceMotion => onChange({ reduceMotion })} /></div>
          <div className="settings-advanced-group"><h3>Hosts</h3><div className="settings-grid"><label className="wide"><span>Orden predeterminado</span><select value={preferences.hostSortMode} onChange={event => onChange({ hostSortMode: event.target.value as AppPreferences["hostSortMode"] })}><option value="name">Nombre</option><option value="recent">Actividad reciente</option><option value="favorites">Favoritos primero</option><option value="created">Más nuevos primero</option></select></label></div><SettingSwitch label="Mostrar dirección" checked={preferences.showAddress} onChange={showAddress => onChange({ showAddress })} /><SettingSwitch label="Mostrar usuario" checked={preferences.showUsername} onChange={showUsername => onChange({ showUsername })} /></div>
          <div className="settings-advanced-group"><h3>Terminal</h3><div className="settings-grid"><label><span>Fuente</span><select value={preferences.terminalFontFamily} onChange={event => onChange({ terminalFontFamily: event.target.value as AppPreferences["terminalFontFamily"] })}><option>Cascadia Code</option><option>JetBrains Mono</option><option>Consolas</option></select></label><label><span>Cursor</span><select value={preferences.terminalCursor} onChange={event => onChange({ terminalCursor: event.target.value as AppPreferences["terminalCursor"] })}><option value="bar">Barra</option><option value="block">Bloque</option><option value="underline">Subrayado</option></select></label></div><SettingSwitch label="Copiar al seleccionar" checked={preferences.copyOnSelect} onChange={copyOnSelect => onChange({ copyOnSelect })} /></div>
          <div className="settings-advanced-group"><h3>Conexión SSH</h3><div className="settings-grid">
            <label><span>Intentos máximos</span><input type="number" min={1} max={10} value={preferences.reconnectAttempts} disabled={!preferences.autoReconnect} onChange={event => onChange({ reconnectAttempts: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })} /></label>
            <label><span>Espera inicial</span><select value={preferences.reconnectDelaySeconds} disabled={!preferences.autoReconnect} onChange={event => onChange({ reconnectDelaySeconds: Number(event.target.value) })}>{[3, 5, 10, 15, 30].map(value => <option key={value} value={value}>{value} segundos</option>)}</select></label>
            <label className="wide"><span>Keepalive SSH</span><select value={preferences.keepaliveSeconds} onChange={event => onChange({ keepaliveSeconds: Number(event.target.value) })}><option value={0}>Desactivado</option><option value={15}>Cada 15 segundos</option><option value={30}>Cada 30 segundos</option><option value={60}>Cada minuto</option><option value={120}>Cada 2 minutos</option></select></label>
          </div></div>
          <div className="settings-advanced-group"><h3>Atajos</h3><p className="field-help">Pulsa Ctrl + Shift y una letra. En macOS, usa Cmd.</p><div className="settings-grid">{([["palette", "Paleta de comandos"], ["newSession", "Nueva sesión"], ["closeSession", "Cerrar sesión"], ["split", "Añadir panel"]] as const).map(([key, label]) => <label key={key} className="wide"><span>{label}</span><input aria-label={"Atajo " + label} readOnly value={preferences.shortcuts[key]} onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && /^[a-z0-9]$/i.test(event.key)) {
              event.preventDefault(); event.stopPropagation();
              const combo = "Ctrl+Shift+" + event.key.toUpperCase();
              if (!isAssignableShortcut(combo)) { setShortcutError("C, V y F están reservados para copiar, pegar y buscar."); return; }
              if (Object.entries(preferences.shortcuts).some(([name, existing]) => name !== key && existing === combo)) { setShortcutError("Este atajo ya está asignado a otra acción."); return; }
              setShortcutError(""); onChange({ shortcuts: { ...preferences.shortcuts, [key]: combo } });
            }
          }} /></label>)}</div>{shortcutError && <p className="form-error" role="alert">{shortcutError}</p>}</div>
        </Disclosure>
      </div>
    </aside>
  </div>;
}

function SettingSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="setting-switch"><span><strong>{label}</strong></span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><i /></label>;
}
