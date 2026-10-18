export type HostSortMode = "name" | "recent" | "favorites" | "created";
export type HostViewMode = "grid" | "list";
export type TerminalThemeId = "nexora" | "dracula" | "nord" | "solarized-dark" | "tokyo-night";
export type UiScale = "compact" | "normal" | "large";

export interface AppPreferences {
  hostSortMode: HostSortMode;
  hostViewMode: HostViewMode;
  showAddress: boolean;
  showUsername: boolean;
  sidebarCollapsed: boolean;
  uiScale: UiScale;
  reduceMotion: boolean;
  terminalFontSize: number;
  terminalTheme: TerminalThemeId;
  autoReconnect: boolean;
  reconnectAttempts: number;
  reconnectDelaySeconds: number;
  keepaliveSeconds: number;
  copyOnSelect: boolean;
  interfaceTheme: "dark" | "light" | "system";
  sidebarWidth: number;
  terminalFontFamily: "Cascadia Code" | "JetBrains Mono" | "Consolas";
  terminalCursor: "bar" | "block" | "underline";
  shortcuts: { palette: string; newSession: string; closeSession: string; split: string };
}

const STORAGE_KEY = "nexora.preferences.v1";

export const DEFAULT_PREFERENCES: AppPreferences = {
  hostSortMode: "name",
  hostViewMode: "grid",
  showAddress: true,
  showUsername: true,
  sidebarCollapsed: false,
  uiScale: "normal",
  reduceMotion: false,
  terminalFontSize: 14,
  terminalTheme: "nexora",
  autoReconnect: true,
  reconnectAttempts: 3,
  reconnectDelaySeconds: 5,
  keepaliveSeconds: 30,
  copyOnSelect: false,
  interfaceTheme: "dark",
  sidebarWidth: 240,
  terminalFontFamily: "Cascadia Code",
  terminalCursor: "bar",
  shortcuts: { palette: "Ctrl+Shift+P", newSession: "Ctrl+Shift+T", closeSession: "Ctrl+Shift+W", split: "Ctrl+Shift+D" },
};

export function loadPreferences(): AppPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AppPreferences>;
    const merged = { ...DEFAULT_PREFERENCES, ...saved };
    return {
      ...merged,
      hostSortMode: ["name", "recent", "favorites", "created"].includes(merged.hostSortMode) ? merged.hostSortMode : "name",
      hostViewMode: merged.hostViewMode === "list" ? "list" : "grid",
      uiScale: ["compact", "normal", "large"].includes(merged.uiScale) ? merged.uiScale : "normal",
      terminalTheme: ["nexora", "dracula", "nord", "solarized-dark", "tokyo-night"].includes(merged.terminalTheme) ? merged.terminalTheme : "nexora",
      terminalFontSize: clampNumber(merged.terminalFontSize, 10, 24, 14),
      reconnectAttempts: clampNumber(merged.reconnectAttempts, 1, 10, 3),
      reconnectDelaySeconds: clampNumber(merged.reconnectDelaySeconds, 2, 60, 5),
      keepaliveSeconds: clampNumber(merged.keepaliveSeconds, 0, 300, 30),
      interfaceTheme: ["dark", "light", "system"].includes(merged.interfaceTheme) ? merged.interfaceTheme : "dark",
      sidebarWidth: clampNumber(merged.sidebarWidth === 288 ? 240 : merged.sidebarWidth, 220, 420, 240),
      terminalFontFamily: ["Cascadia Code", "JetBrains Mono", "Consolas"].includes(merged.terminalFontFamily) ? merged.terminalFontFamily : "Cascadia Code",
      terminalCursor: ["bar", "block", "underline"].includes(merged.terminalCursor) ? merged.terminalCursor : "bar",
      shortcuts: normalizeShortcuts(merged.shortcuts),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function isAssignableShortcut(combo: string): boolean {
  return /^Ctrl\+Shift\+[A-Z0-9]$/.test(combo) && !["Ctrl+Shift+C", "Ctrl+Shift+V", "Ctrl+Shift+F"].includes(combo);
}
export function normalizeShortcuts(value: unknown): AppPreferences["shortcuts"] {
  const defaults = DEFAULT_PREFERENCES.shortcuts;
  if (!value || typeof value !== "object") return { ...defaults };
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const combo = (value as Record<string, unknown>)[key];
    if (typeof combo === "string" && isAssignableShortcut(combo)) result[key] = combo;
  }
  if (new Set(Object.values(result)).size !== 4) return { ...defaults };
  return result;
}
export function matchesShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key">, shortcut: string): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && `Ctrl+Shift+${event.key.toUpperCase()}` === shortcut;
}

export function savePreferences(preferences: AppPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Las preferencias no deben impedir el funcionamiento de las conexiones.
  }
}

function clampNumber(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
