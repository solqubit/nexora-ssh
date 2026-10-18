import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { ContextMenuSurface } from "./ContextMenuSurface";

export function ActionMenu({ label, children, disabled = false, icon = <MoreHorizontal size={17} /> }: {
  label: string; children: ReactNode; disabled?: boolean; icon?: ReactNode;
}) {
  const id = useId(), button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if ((event.target as Element).closest?.("[data-action-menu]")?.getAttribute("data-action-menu") !== id) setPosition(null);
    };
    const close = () => setPosition(null);
    document.addEventListener("pointerdown", outside, true); window.addEventListener("blur", close);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", close); };
  }, [position, id]);
  return <>
    <button ref={button} type="button" className={`icon-button action-menu-toggle ${position ? "active" : ""}`} data-action-menu={id} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(position)} disabled={disabled} onClick={() => {
      const bounds = button.current!.getBoundingClientRect();
      setPosition(position ? null : { x: bounds.right - 232, y: bounds.bottom + 6 });
    }}>{icon}</button>
    {position && createPortal(<div data-action-menu={id} onKeyDown={event => event.stopPropagation()} onClick={event => {
      event.stopPropagation();
      const item = (event.target as Element).closest("[role^='menuitem']");
      if (item && !item.hasAttribute("aria-expanded") && !item.hasAttribute("disabled")) setPosition(null);
    }}><ContextMenuSurface {...position} onClose={() => setPosition(null)} className="action-menu">{children}</ContextMenuSurface></div>, document.body)}
  </>;
}
