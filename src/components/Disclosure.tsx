import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function Disclosure({ title, children, defaultOpen = false, menu = false }: {
  title: string; children: ReactNode; defaultOpen?: boolean; menu?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return <div className={menu ? "menu-disclosure" : "disclosure"}>
    <button type="button" className="disclosure-toggle" role={menu ? "menuitem" : undefined} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <span>{title}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div id={id} className="disclosure-body">{children}</div>}
  </div>;
}
