export interface QuickTarget { address: string; username: string; port: number }
export function parseQuickTarget(input: string): QuickTarget {
  const text = input.trim();
  if (!text || text.length > 1024 || /[\r\n\0;&|$<>`"']/.test(text)) throw new Error("Escribe un destino SSH, sin comandos ni redirecciones.");
  const parts = text.split(/\s+/);
  let port = 22, username = "", target = "", portSpecified = false;
  if (parts[0] === "ssh") parts.shift();
  while (parts.length) {
    const part = parts.shift()!;
    if (part === "-p" || /^-p\d+$/.test(part)) {
      if (portSpecified) throw new Error("El puerto aparece más de una vez.");
      const value = part === "-p" ? parts.shift() : part.slice(2);
      if (!value || !/^\d+$/.test(value)) throw new Error("El puerto debe ser numérico.");
      port = Number(value); portSpecified = true;
    } else if (part === "-l") {
      if (username) throw new Error("El usuario aparece más de una vez.");
      username = parts.shift() ?? "";
      if (!username || username.startsWith("-")) throw new Error("Falta el usuario SSH.");
    } else if (part.startsWith("-") || target) throw new Error("Solo se admiten destino, -p y -l; no comandos remotos.");
    else target = part;
  }
  if (!target) throw new Error("Falta la dirección del servidor.");
  const at = target.indexOf("@");
  if (at >= 0) {
    if (username || at === 0 || target.indexOf("@", at + 1) >= 0) throw new Error("El usuario SSH no es válido.");
    username = target.slice(0, at); target = target.slice(at + 1);
  }
  const bracket = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  const hostPort = target.match(/^([^:]+):(\d+)$/);
  if (bracket || hostPort) {
    const match = bracket ?? hostPort!;
    target = match[1];
    if (match[2]) {
      if (portSpecified) throw new Error("El puerto aparece más de una vez.");
      port = Number(match[2]);
    }
  } else if (/[\[\]]/.test(target) || (target.includes(":") && !/^[0-9a-f:]+$/i.test(target))) throw new Error("Usa [dirección IPv6]:puerto para indicar un puerto IPv6.");
  if (!target || target.length > 255 || /[\s/\\@?#]/.test(target) || target.startsWith("-")) throw new Error("La dirección del servidor no es válida.");
  if (username.length > 128 || /[\s@/\\:]/.test(username)) throw new Error("El usuario SSH no es válido.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("El puerto debe estar entre 1 y 65535.");
  return { address: target, username, port };
}
