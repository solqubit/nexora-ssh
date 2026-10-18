import { useEffect, useRef } from "react";

const MENU_ITEM = ":is([role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']):not([disabled])";

/**
 * Navegación de teclado para menús contextuales: enfoca el primer elemento al
 * abrir, mueve el foco con las flechas y devuelve el foco al cerrar.
 */
export function useMenuFocus<T extends HTMLElement>(onClose: () => void) {
  const elementRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...(elementRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])].filter((item) => item.offsetParent !== null);
    const frame = window.requestAnimationFrame(() => items()[0]?.focus());

    const focusAt = (index: number) => {
      const available = items();
      if (!available.length) return;
      const wrapped = (index + available.length) % available.length;
      available[wrapped].focus();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!elementRef.current) return;
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      event.stopPropagation();
      const available = items();
      const current = available.findIndex((item) => item === document.activeElement);
      if (event.key === "Home") focusAt(0);
      else if (event.key === "End") focusAt(available.length - 1);
      else focusAt(current < 0 ? 0 : current + (event.key === "ArrowDown" ? 1 : -1));
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus();
    };
  }, []);

  return elementRef;
}
