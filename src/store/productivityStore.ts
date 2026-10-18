import { create } from "zustand";
import { useAppStore } from "./appStore";
import { productivitySchema } from "../lib/productivityValidation";
import type { SavedWorkspace, Snippet, ProductivityData } from "../types";

interface ProductivityStore extends ProductivityData {
  saveSnippet: (snippet: Snippet) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
}
async function update(mutation: (value: ProductivityData) => ProductivityData) {
  await useAppStore.getState().updateProductivity(current => productivitySchema.parse(mutation(current)));
}
export const useProductivityStore = create<ProductivityStore>(() => ({
  ...(useAppStore.getState().snapshot.productivity ?? { workspaces: [], snippets: [] }),
  saveSnippet: snippet => update(value => ({ ...value, snippets: [...value.snippets.filter(item => item.id !== snippet.id), snippet] })),
  deleteSnippet: id => update(value => ({ ...value, snippets: value.snippets.filter(item => item.id !== id) })),
}));
useAppStore.subscribe((state, previous) => {
  if (state.snapshot !== previous.snapshot) useProductivityStore.setState(state.snapshot.productivity ?? { workspaces: [], snippets: [] });
});

export function snippetVariables(command: string): string[] {
  return Array.from(new Set(Array.from(command.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g), match => match[1])));
}
export function expandSnippet(command: string, values: Record<string, string>, shell: "posix" | "powershell" = "posix"): string {
  const variables = snippetVariables(command);
  if (variables.length && (/<<|\$\(|\$\{|`|\(\(/.test(command) || shell === "powershell" && /@['"]/.test(command))) throw new Error("Usa las variables como argumentos simples, fuera de sustituciones, aritmética o heredocs.");
  let quote = "", escaped = false, cursor = 0;
  return command.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name: string, offset: number) => {
    for (; cursor < offset; cursor++) {
      const char = command[cursor];
      if (escaped) { escaped = false; continue; }
      if (shell === "posix" && char === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = ""; }
      else if (char === "'" || char === '"') quote = char;
    }
    if (quote || escaped) throw new Error(`Escribe {{${name}}} fuera de comillas y sin barras de escape; Nexora protege el argumento al completarlo.`);
    cursor = offset + name.length + 4;
    if (values[name] === undefined) throw new Error(`Falta el valor de ${name}.`);
    if (/[\x00-\x1f\x7f]/.test(values[name])) throw new Error("Las variables no admiten caracteres de control.");
    return `'${values[name].replaceAll("'", shell === "powershell" ? "''" : "'\\''")}'`;
  });
}
