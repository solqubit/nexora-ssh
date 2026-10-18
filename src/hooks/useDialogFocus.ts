import { useEffect, useRef } from "react";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, disabled = false, active = true) {
  const elementRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const disabledRef = useRef(disabled);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = elementRef.current;
      const initial = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?? dialog?.querySelector<HTMLElement>("input:not([type='hidden']):not([disabled])")
        ?? dialog?.querySelector<HTMLElement>("textarea:not([disabled])")
        ?? dialog?.querySelector<HTMLElement>("select:not([disabled])")
        ?? dialog?.querySelector<HTMLElement>("button:not([disabled])")
        ?? dialog;
      initial?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = elementRef.current;
      if (!dialog) return;
      if (event.key === "Escape" && !disabledRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [active]);

  return elementRef;
}
