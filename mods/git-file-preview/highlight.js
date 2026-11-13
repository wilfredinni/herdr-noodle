// bat supplies full-file language context; only its colors reach the diff rows.
export function ansiLines(output) {
  const lines = [[]];
  let color = null;
  for (const part of output.split(/(\x1b\[[0-9;]*m|\n)/)) {
    if (!part) continue;
    if (part === "\n") { lines.push([]); continue; }
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0 || code === 39) color = null;
        else if (code >= 30 && code <= 37) color = code - 30;
        else if (code >= 90 && code <= 97) color = code - 90 + 8;
        else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
          const rgb = codes.slice(i + 2, i + 5);
          if (code === 38 && rgb.length === 3) color = "#" + rgb.map(n => n.toString(16).padStart(2,"0")).join("");
          i += 4;
        } else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
          const index = codes[i + 2];
          if (code === 38) {
            if (index < 16) color = index;
            else {
              const n = index - 16, levels = [0,95,135,175,215,255];
              const rgb = index >= 232 ? Array(3).fill(8 + (index - 232) * 10) : [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]];
              color = "#" + rgb.map(n => n.toString(16).padStart(2,"0")).join("");
            }
          }
          i += 2;
        }
      }
    } else {
      const line = lines[lines.length - 1], last = line[line.length - 1];
      if (last && last.color === color) last.text += part;
      else line.push({ text: part, color });
    }
  }
  if (output.endsWith("\n")) lines.pop();
  return lines;
}

const SCRIPT = `set -o pipefail
if [ "$2" = "WORKTREE" ]; then
  head -c 1048576 -- "./$1"
elif [ "$2" = "INDEX" ]; then
  git --no-optional-locks -c core.fsmonitor=false show ":$1" | head -c 1048576
else
  git --no-optional-locks -c core.fsmonitor=false show "$2:$1" | head -c 1048576
fi | bat --no-config --style=plain --paging=never --color=always --theme=ansi --tabs=4 --wrap=never --strip-ansi=always --file-name "$1"`;

export async function highlightRows(selection, rows, host, sourceRevision) {
  const status = selection.diffMode === "staged" ? selection.file.indexStatus : selection.file.status;
  const before = selection.file.fresh ? null : status === "U" ? "HEAD" : selection.diffMode === "unstaged" ? "INDEX" : status === "A" ? null : selection.hash ? selection.parent : selection.hasHead ? "HEAD" : null;
  const after = status === "D" ? null : selection.hash || (selection.diffMode === "staged" ? "INDEX" : "WORKTREE");
  const source = async revision => {
    if (!revision) return [];
    const result = await host.exec("bash", ["-c", SCRIPT, "herdr-diff-syntax", selection.file.path, revision], { cwd: selection.root, on: selection.on });
    if (result.code !== 0) throw new Error("Syntax highlighting unavailable · bat is required on this machine");
    return ansiLines(result.stdout);
  };
  const [oldLines, newLines] = sourceRevision ? [[], await source(sourceRevision)] : await Promise.all([source(before), source(after)]);
  for (const row of rows) {
    if (row.number === undefined) continue;
    const spans = (row.kind === "-" ? oldLines : newLines)[row.number - 1];
    // A save racing the diff must never replace the displayed source text.
    if (spans && spans.length <= 512 && spans.map(span => span.text).join("") === row.text) row.spans = spans;
  }
}
