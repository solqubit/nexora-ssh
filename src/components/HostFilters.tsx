import { X } from "lucide-react";
import { filterKey, uniqueLabels } from "../lib/hostFilters";
export function HostFilters({ environments, tags, environment, selectedTags, onEnvironment, onTags }: {
  environments: string[]; tags: string[]; environment: string | null; selectedTags: string[];
  onEnvironment: (environment: string | null) => void; onTags: (tags: string[]) => void;
}) {
  const availableTags = tags.filter(tag => !selectedTags.some(selected => filterKey(selected) === filterKey(tag)));
  const active = environment !== null || selectedTags.length > 0;
  if (!environments.length && !tags.length && !active) return null;
  return <div className="host-filters" role="group" aria-label="Filtros de hosts">
    {(environments.length > 0 || environment !== null) && <label><span>Entorno</span><select aria-label="Filtrar por entorno" value={environment === null ? "all" : environment === "" ? "none" : `name:${environment}`} onChange={event => onEnvironment(event.target.value === "all" ? null : event.target.value === "none" ? "" : event.target.value.slice(5))}>
      <option value="all">Todos los entornos</option><option value="none">Sin entorno</option>{uniqueLabels([...environments, environment ?? ""]).map(name => <option key={name} value={`name:${name}`}>{name}</option>)}
    </select></label>}
    {availableTags.length > 0 && <label><span>Etiquetas</span><select aria-label="Añadir filtro de etiqueta" value="" onChange={event => { if (event.target.value) onTags([...selectedTags, event.target.value]); }}>
      <option value="">{availableTags.length ? "Añadir etiqueta…" : selectedTags.length ? "Todas seleccionadas" : "Sin etiquetas"}</option>{availableTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
    </select></label>}
    {selectedTags.map(tag => <button className="host-filter-chip" key={tag} aria-label={`Quitar filtro ${tag}`} onClick={() => onTags(selectedTags.filter(item => item !== tag))}>{tag}<X size={12} /></button>)}
    {active && <button className="host-filter-clear" onClick={() => { onEnvironment(null); onTags([]); }}>Limpiar filtros</button>}
    {selectedTags.length > 1 && <small>Coincide con todas las etiquetas</small>}
  </div>;
}
