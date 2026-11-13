const normalize = path => (/^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replaceAll("\\", "/") : path).replace(/\/+$/, "") || "/";
const priority = { A: 1, D: 2, M: 2, U: 3 };
const merge = (previous, next) => (priority[previous] || 0) >= priority[next] ? previous : next;

export function gitState(root, status = "", tracked = "") {
  const state = { root: root ? normalize(root) : null, marks: new Map(), tracked: new Set(), ignored: new Set() };
  if (!root) return state;
  const parents = (path, visit) => {
    for (let end = path.lastIndexOf("/"); end > state.root.length; end = path.lastIndexOf("/", end - 1)) visit(path.slice(0, end));
  };
  for (const relative of tracked.split("\0").filter(Boolean)) {
    const path = normalize(`${state.root}/${relative}`);
    state.tracked.add(path); parents(path, path => state.tracked.add(path));
  }
  for (const entry of status.split("\0").filter(Boolean)) {
    const xy = entry.slice(0, 2), path = normalize(`${state.root}/${entry.slice(3)}`);
    if (xy === "!!") { state.ignored.add(path); continue; }
    const mark = xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy === "??" || xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
    state.marks.set(path, merge(state.marks.get(path), mark));
    parents(path, path => state.marks.set(path, merge(state.marks.get(path), mark === "D" ? "M" : mark)));
  }
  return state;
}

export function fileState(state, path) {
  path = normalize(path);
  if (!state?.root || (path !== state.root && !path.startsWith(state.root + "/"))) return "outside";
  if (state.marks.has(path)) return state.marks.get(path);
  if (state.tracked.has(path)) return "tracked";
  for (const ignored of state.ignored) if (path === ignored || path.startsWith(ignored + "/")) return "ignored";
  return "outside";
}
