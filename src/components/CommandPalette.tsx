import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ArrowRight, TerminalSquare, X } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";
export interface PaletteItem { id: string; label: string; detail: string; category: string; keywords?: string; run: () => void }
export function CommandPalette({ items, onClose, onQuickConnect }: { items: PaletteItem[]; onClose: () => void; onQuickConnect: (input: string) => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => { const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean); return items.filter(item => terms.every(term => `${item.label} ${item.detail} ${item.category} ${item.keywords ?? ""}`.toLocaleLowerCase().includes(term))).slice(0, 80); }, [items, query]);
  const canConnect = query.includes("@") || /^ssh\s|^\[|^\d+\./.test(query);
  const count = filtered.length + Number(canConnect);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [selected, dialogRef]);
  const choose = (index: number) => { const item = filtered[index]; if (item) { onClose(); item.run(); } else if (canConnect && index === filtered.length) { onQuickConnect(query); } };
  return <div className="modal-backdrop palette-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos" tabIndex={-1}>
      <div className="palette-search"><Search size={20} /><input ref={inputRef} role="combobox" aria-label="Buscar acción o conexión" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={count ? `palette-result-${Math.min(selected, count - 1)}` : undefined} value={query} placeholder="Buscar un host, acción o escribir usuario@servidor…" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected(current => count ? (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count : 0); } if (event.key === "Enter") { event.preventDefault(); choose(Math.min(selected, count - 1)); } }} /><button aria-label="Cerrar paleta" onClick={onClose}><X size={18} /></button></div>
      <div id="palette-results" className="palette-results" role="listbox" aria-label="Resultados">
        {filtered.map((item, index) => <button key={item.id} id={`palette-result-${index}`} role="option" aria-selected={selected === index} onMouseMove={() => setSelected(index)} onClick={() => choose(index)}><span className="palette-category">{item.category}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={16} /></button>)}
        {canConnect && <button id={`palette-result-${filtered.length}`} role="option" aria-selected={selected === filtered.length} onMouseMove={() => setSelected(filtered.length)} onClick={() => choose(filtered.length)}><TerminalSquare size={18} /><span><strong>Conexión rápida</strong><small>{query}</small></span><ArrowRight size={16} /></button>}
        {!count && <p className="palette-empty">No hay resultados. Puedes escribir usuario@servidor para crear una conexión.</p>}
      </div>
      <footer><span><kbd>↑</kbd> <kbd>↓</kbd> Seleccionar</span><span><kbd>Enter</kbd> Abrir</span><span><kbd>Esc</kbd> Cerrar</span></footer>
    </div>
  </div>;
}
