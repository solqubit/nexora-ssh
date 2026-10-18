import { useLayoutEffect, useState, type ReactNode } from "react";
import { useMenuFocus } from "../hooks/useMenuFocus";

/**
 * Contenedor común de los menús contextuales: posiciona el menú, aporta la
 * navegación de teclado y evita que el clic derecho dentro lo vuelva a abrir.
 */
export function ContextMenuSurface({ x, y, onClose, className = "", children }: {
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(onClose);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const fit = () => {
      const element = menuRef.current;
      if (!element) return;
      const left = Math.max(10, Math.min(x, window.innerWidth - element.offsetWidth - 10));
      const top = Math.max(10, Math.min(y, window.innerHeight - element.offsetHeight - 10));
      setPosition(current => current.left === left && current.top === top ? current : { left, top });
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [menuRef, x, y]);
  return (
    <div
      ref={menuRef}
      className={`app-context-menu ${className}`.trim()}
      style={position}
      role="menu"
      tabIndex={-1}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      {children}
    </div>
  );
}
