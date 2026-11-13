import { appHome, exec, readTextFile } from "herdr";

// Stable CLI auth references are shared by usage and future AI actions. Credentials stay with each CLI.
export const CONNECTIONS = [
  { id: "codex", name: "Codex", icon: "icons/codex.svg", driver: "codex-app-server", authRef: "codex:default", docs: "https://learn.chatgpt.com/docs/app-server" },
  { id: "claude", name: "Claude", icon: "icons/claude.svg", driver: "claude-cli", authRef: "claude:default", docs: "https://code.claude.com/docs/en/costs" },
  { id: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: true, driver: "opencode-cli", authRef: "opencode:default", docs: "https://opencode.ai/docs/cli/commands/" },
  { id: "kiro", name: "Kiro", icon: "icons/kiro.svg", driver: "kiro-cli", authRef: "kiro:default", docs: "https://kiro.dev/docs/reference/slash-commands/" },
];
export const connectionById = id => CONNECTIONS.find(connection => connection.id === id) ?? null;
const finite = n => typeof n === "number" && Number.isFinite(n) && n >= 0;

export async function readConnection(connection, machine = null, directory = null) {
  if (!CONNECTIONS.includes(connection)) throw new Error("Unknown AI connection");
  const script = await readTextFile(`${appHome()}/mods/workspace-usage/collect.py`);
  if (!script) throw new Error("Usage collector is missing");
  const result = await exec("python3", ["-c", script, connection.id, ...(directory ? [directory] : [])], { on: machine, timeout: 75000 });
  if (result.code !== 0) throw new Error("Usage collector failed");
  const data = JSON.parse(result.stdout);
  if (!["ok", "missing", "unavailable", "error"].includes(data.state) || !finite(data.checkedAt) || !["api", "subscription", "mixed", "unknown"].includes(data.mode))
    throw new Error("Invalid usage response");
  for (const window of data.windows ?? []) {
    if (typeof window.label !== "string" || !finite(window.usedPercent) || window.usedPercent > 100 || (window.resetsAt != null && !finite(window.resetsAt)))
      throw new Error("Invalid subscription quota");
  }
  if (data.spend && (!data.spend.today || !data.spend.week)) throw new Error("Incomplete cost estimate");
  for (const period of Object.values(data.spend ?? {})) for (const field of ["apiEstimateUsd", "subscriptionEquivalentUsd", "unclassifiedUsd"])
    if (period[field] != null && !finite(period[field])) throw new Error("Invalid cost estimate");
  return { ...data, connectionId: connection.id, machine, directory, authRef: connection.authRef };
}

export function mergeReading(previous, reading) {
  const clear = reading.state === "missing" || reading.authenticated === false;
  return { reading, good: reading.state === "ok" ? reading : clear ? null : previous?.good ?? null };
}

export function stale(record, now = Date.now() / 1000) {
  return Boolean(record?.good && (record.reading?.state !== "ok" || now - record.good.checkedAt > 900));
}

export function quotaMeter(window, now = Date.now() / 1000) {
  const expired = window.resetsAt != null && window.resetsAt <= now;
  const duration = window.minutes > 0 ? window.minutes * 60 : null;
  const tick = !expired && duration && window.resetsAt != null
    ? Math.max(0, Math.min(1, (now - (window.resetsAt - duration)) / duration)) : null;
  return {
    label: window.label.replace(/^Go · /, "").replace(/\b7d\b/g, "wk").replace(/\bmonth\b/g, "mo"),
    percent: expired ? null : window.usedPercent,
    tick,
  };
}

export const modeLabel = mode => ({ subscription: "Subscription", api: "API", mixed: "API + subscription", unknown: "Connection" })[mode] ?? "Connection";
export const age = (at, now = Date.now() / 1000) => !finite(at) ? "Not read yet" : now - at < 60 ? "Just updated" : `${Math.floor((now - at) / 60)}m ago`;
export function resetIn(at, now = Date.now() / 1000) {
  if (at == null) return "Reset time unavailable";
  const minutes = Math.max(0, Math.ceil((at - now) / 60));
  if (!minutes) return "Awaiting quota refresh";
  if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets in ${minutes}m`;
}
