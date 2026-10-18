/** Bracketed paste is needed to insert line breaks without submitting them to a shell. */
export function prepareSnippetInput(text: string, execute: boolean, bracketedPaste: boolean): string {
  if (text.length > 32000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error("El comando contiene caracteres de control no admitidos.");
  if (!execute && /[\r\n]/.test(text) && !bracketedPaste) throw new Error("Esta terminal no admite insertar varias líneas sin ejecutarlas. Inserta una sola línea o usa Ejecutar después de revisar el comando.");
  return (bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text) + (execute ? "\r" : "");
}
