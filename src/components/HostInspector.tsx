import { CopyPlus, Trash2 } from "lucide-react";
import { HostModal, type HostModalProps } from "./HostModal";
import type { Host, HostGroup } from "../types";

interface HostInspectorProps {
  host: Host;
  groups: HostGroup[];
  defaultKeepalive?: number;
  onClose: () => void;
  onOpen: () => void;
  onSave: HostModalProps["onSave"];
  onDiscard: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function HostInspector({ host, groups, defaultKeepalive, onClose, onOpen, onSave, onDiscard, onDirtyChange, onBusyChange, onDuplicate, onDelete }: HostInspectorProps) {
  return <aside className="inspector inspector-editable" data-app-context="host" data-host-id={host.id}>
    <HostModal key={host.id} inline host={host} vaultId={host.vaultId} selectedGroupId={host.groupId} groups={groups}
      defaultKeepalive={defaultKeepalive} onClose={onClose} onOpen={onOpen} onSave={onSave}
      onDiscard={onDiscard} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange}
      secondaryActions={<div className="host-inline-secondary"><button className="button secondary" type="button" onClick={onDuplicate}><CopyPlus size={14} />Duplicar</button><button className="button subtle-danger" type="button" onClick={onDelete}><Trash2 size={14} />Eliminar</button></div>}
    />
  </aside>;
}
