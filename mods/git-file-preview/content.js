import { highlightRows } from "./highlight.js";
import { lineChanges } from "./gutter.js";
export const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const isMarkdown = path => /\.(md|markdown|mdown)$/i.test(path);
const MAX_LINES = 1500, MAX_LINE = 4000, MAX_MARKDOWN = 200000;
const untab = text => text.replace(/[^\t]*\t/g, s => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

export function validateSelection(selection) {
  const path = selection?.file?.path;
  if (typeof selection?.root !== "string" || !selection.root || selection.root.includes("\0") || typeof path !== "string" || !path || /^(?:[\\/]|[a-z]:)/i.test(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error("Invalid file selection");
  for (const hash of [selection.hash, selection.parent]) if (hash != null && !/^[a-f0-9]{40,64}$/i.test(hash)) throw new Error("Invalid commit selection");
  if (selection.diffMode != null && !["all", "staged", "unstaged"].includes(selection.diffMode)) throw new Error("Invalid diff selection");
  return selection;
}

export async function git(selection, args, host) {
  const result = await host.exec("git", [...READ, ...args], { cwd: selection.root, on: selection.on });
  if (result.code !== 0) throw new Error(result.stderr || "Cannot read Git content");
  return result.stdout;
}

export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.slice(0, MAX_LINES).map(line => {
    line = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "… (line truncated)" : line;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = untab(line.slice(1).replace(/\r$/, "")) || " ";
    if (kind === "-") return { kind, number: old, oldNumber: old++, text };
    if (kind === "+") return { kind, number: next, newNumber: next++, text };
    if (kind === " ") return { kind, number: next, oldNumber: old++, newNumber: next++, text };
    return { kind: "", text: line };
  });
}

export function splitRows(rows) {
  const pairs = []; let removed = [], added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) pairs.push({ before: removed[i], after: added[i] });
    removed = []; added = [];
  };
  for (const row of rows) {
    if (row.kind === "-") { if (added.length) flush(); removed.push(row); }
    else if (row.kind === "+") added.push(row);
    else { flush(); pairs.push({ before: row, after: row }); }
  }
  flush(); return pairs;
}

export async function readDiff(input, host, previous) {
  const s = validateSelection(input), file = s.file;
  let lines, header = "";
  if (!s.hash && s.diffMode !== "staged" && (file.fresh || (!s.hasHead && file.status === "A" && s.diffMode !== "unstaged"))) {
    const text = await host.readTextFile(`${s.root}/${file.path}`, { on: s.on });
    if (text === null) throw new Error("Cannot preview this file (too large, missing, or unreadable)");
    if (text.includes("\0")) lines = ["Binary file · no text diff"];
    else {
      const count = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
      lines = count ? [`@@ -0,0 +1,${count} @@`, ...text.replace(/\n$/, "").split("\n").map(line => `+${line}`)] : ["Empty file"];
    }
  } else {
    const options = ["--no-ext-diff", "--no-textconv", "--no-color"];
    const args = s.hash
      ? s.parent ? ["diff", ...options, s.parent, s.hash, "--", file.path] : ["show", "--format=", "--root", ...options, s.hash, "--", file.path]
      : ["diff", ...options, ...(file.status === "U" ? ["HEAD"] : s.diffMode === "staged" ? ["--cached"] : s.diffMode === "unstaged" ? [] : s.hasHead ? ["HEAD"] : []), "--", file.path];
    const output = await git(s, args, host), all = output.replace(/\n$/, "").split("\n"), start = all.findIndex(line => line.startsWith("@@"));
    header = all.slice(0, start < 0 ? 10 : start).join("\n");
    lines = start < 0 ? [file.binary || output.includes("Binary files ") ? "Binary file · no text diff" : "No text diff available"] : all.slice(start);
  }
  const signature = JSON.stringify([header, lines.slice(0, MAX_LINES).map(line => line.slice(0, MAX_LINE + 1)), lines.length > MAX_LINES]);
  if (previous?.signature === signature && !previous.syntaxError) return previous;
  const rows = diffRows(lines);
  let syntaxError = null;
  if (rows.some(row => row.number !== undefined)) {
    try { await highlightRows(s, rows, host); }
    catch (error) { syntaxError = String(error.message || error); }
  }
  return { rows, truncated: lines.length > MAX_LINES, syntaxError, signature,
    stats: { add: lines.filter(line => line.startsWith("+")).length, del: lines.filter(line => line.startsWith("-")).length } };
}

export async function readSource(input, host) {
  const s = validateSelection(input), deleted = (s.diffMode === "staged" ? s.file.indexStatus || s.file.status : s.file.status) === "D";
  let text;
  if (s.hash || deleted) {
    const revision = deleted ? (s.hash ? s.parent : s.diffMode === "unstaged" ? "" : s.hasHead ? "HEAD" : null) : s.hash;
    if (revision == null) throw new Error("No file content exists before this deletion");
    text = await git(s, ["show", `${revision}:${s.file.path}`], host);
  } else if (s.diffMode === "staged") text = await git(s, ["show", `:${s.file.path}`], host);
  else text = await host.readTextFile(`${s.root}/${s.file.path}`, { on: s.on });
  if (text === null) throw new Error("Cannot read file (too large, missing, or unreadable)");
  if (text.includes("\0")) throw new Error("Binary file · no source preview");
  return { text: text.slice(0, 400000), truncated: text.length > 400000, deleted, lineEnding: /\r\n/.test(text) ? (/([^\r]|^)\n/.test(text) ? "Mixed" : "CRLF") : "LF" };
}

export async function readMarkdown(input, host) {
  const source = await readSource(input, host);
  return { ...source, text: source.text.slice(0, MAX_MARKDOWN), truncated: source.truncated || source.text.length > MAX_MARKDOWN };
}


export async function readFile(input, host, previous) {
  const s = validateSelection(input), source = await readSource(s, host);
  const lines = source.text.replace(/\n$/, "").split("\n");
  const diff = s.hash || s.diffMode === "staged" || source.deleted || s.file.status === "A" || s.gitRoot === null ? null : await host.exec("git", [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", "HEAD", "--", s.file.path], { cwd: s.root, on: s.on }).catch(() => null);
  const marks = diff?.code === 0 ? lineChanges(diff.stdout, Math.min(lines.length, 5000)) : new Map();
  const signature = JSON.stringify([source, [...marks]]);
  if (previous?.signature === signature && !previous.syntaxError) return previous;
  const rows = lines.slice(0, 5000).map((line, index) => ({ kind: "", number: index + 1,
    text: untab((line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "… (line truncated)" : line).replace(/\r$/, "")) || " " }));
  let syntaxError = null;
  const revision = source.deleted ? (s.hash ? s.parent : s.diffMode === "unstaged" ? "INDEX" : "HEAD") : s.hash || (s.diffMode === "staged" ? "INDEX" : "WORKTREE");
  await highlightRows(s, rows, host, revision).catch(error => { syntaxError = String(error.message || error); });
  for (const row of rows) {
    if (s.file.status === "A" && source.text) row.change = "added";
    else Object.assign(row, marks.get(row.number));
  }
  return { rows, truncated: source.truncated || lines.length > 5000, syntaxError, signature, deleted: source.deleted, lineEnding: source.lineEnding };
}
