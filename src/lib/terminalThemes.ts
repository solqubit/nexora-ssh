import type { ITheme } from "@xterm/xterm";
import type { TerminalThemeId } from "./preferences";

export interface TerminalThemeOption {
  id: TerminalThemeId;
  label: string;
  theme: ITheme;
}

export const TERMINAL_THEME_OPTIONS: TerminalThemeOption[] = [
  {
    id: "nexora",
    label: "Nexora",
    theme: {
      background: "#0b0d12", foreground: "#dfe3ec", cursor: "#9f91ff", cursorAccent: "#0b0d12", selectionBackground: "#40397099",
      black: "#111318", red: "#ff7b8d", green: "#54d6b4", yellow: "#f4c875", blue: "#77a7ff", magenta: "#c49aff", cyan: "#59d8e6", white: "#e7e9ef", brightBlack: "#717887",
      brightRed: "#ff9aaa", brightGreen: "#78e5c7", brightYellow: "#ffe09a", brightBlue: "#9bbfff", brightMagenta: "#d8b6ff", brightCyan: "#84e6ee", brightWhite: "#ffffff",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    theme: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36", selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2", brightBlack: "#6272a4",
      brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    label: "Nord",
    theme: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", cursorAccent: "#2e3440", selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0", brightBlack: "#4c566a",
      brightRed: "#d08770", brightGreen: "#b5d09b", brightYellow: "#f0d399", brightBlue: "#8fbcbb", brightMagenta: "#c79fbd", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized",
    theme: {
      background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36", selectionBackground: "#073642",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#586e75",
      brightRed: "#cb4b16", brightGreen: "#93a1a1", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#2aa198", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    theme: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26", selectionBackground: "#33467c",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6", brightBlack: "#414868",
      brightRed: "#ff899d", brightGreen: "#b9f27c", brightYellow: "#ff9e64", brightBlue: "#8db0ff", brightMagenta: "#c7a9ff", brightCyan: "#a4daff", brightWhite: "#c0caf5",
    },
  },
];

export function getTerminalTheme(id: TerminalThemeId): ITheme {
  return TERMINAL_THEME_OPTIONS.find((option) => option.id === id)?.theme ?? TERMINAL_THEME_OPTIONS[0].theme;
}
