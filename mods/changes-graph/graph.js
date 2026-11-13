export const GRAPH_LIMIT = 200;
export const GRAPH_ROW_HEIGHT = 28;
export const GRAPH_ARGS = ["log", "--all", "--topo-order", "--no-color", "--decorate=full", `--max-count=${GRAPH_LIMIT}`, "--format=%H%x00%h%x00%D%x00%s%x00%an%x00%ar%x00%P%x00%at"];

export const HISTORY_ARGS = [...GRAPH_ARGS.filter(arg => arg !== "--all" && arg !== "--topo-order"), "--date-order", "HEAD"];

export function graphRows(output) {
  const lanes = [];
  let nextColor = 0;
  return output.split("\n").filter(Boolean).map(line => {
    const [fullHash, hash, refs, subject, author, age, parents, timestamp] = line.split("\0");
    let lane = lanes.findIndex(item => item.hash === fullHash);
    const incoming = lane >= 0;
    if (!incoming) { lane = lanes.length; lanes.push({ hash: fullHash, color: nextColor++ }); }
    const before = [...lanes], node = lanes[lane];
    lanes.splice(lane, 1);
    const parentIds = parents ? parents.split(" ") : [];
    parentIds.forEach((parent, index) => {
      if (!lanes.some(item => item.hash === parent)) lanes.splice(Math.min(lane + index, lanes.length), 0, { hash: parent, color: index === 0 ? node.color : nextColor++ });
    });
    const edges = before.flatMap((item, from) => item.hash === fullHash
      ? incoming ? [{ from, to: lane, top: 0, bottom: GRAPH_ROW_HEIGHT / 2, color: node.color }] : []
      : [{ from, to: lanes.findIndex(next => next.hash === item.hash), top: 0, bottom: GRAPH_ROW_HEIGHT, color: item.color }]);
    for (const parent of parentIds) {
      const to = lanes.findIndex(item => item.hash === parent);
      edges.push({ from: lane, to, top: GRAPH_ROW_HEIGHT / 2, bottom: GRAPH_ROW_HEIGHT, color: lanes[to].color });
    }
    return { fullHash, hash, refs: refs?.trim(), subject, author, age, parents, timestamp: Number(timestamp), lane, color: node.color, edges, lanes: Math.max(before.length, lanes.length) };
  });
}

export const COMMIT_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%B";
export function commitDetail(metadata, statuses, stats) {
  const [hash, parents, author, email, date, message] = metadata.split("\0");
  const totals = new Map(stats.split("\0").filter(Boolean).map(entry => {
    const [add, del, ...path] = entry.split("\t");
    return [path.join("\t"), { add: Number(add) || 0, del: Number(del) || 0, binary: add === "-" }];
  }));
  const entries = statuses.split("\0"), files = [];
  for (let i = 0; i + 1 < entries.length; i += 2) files.push({ status: entries[i], path: entries[i + 1], ...totals.get(entries[i + 1]) });
  return { hash, parents: parents ? parents.split(" ") : [], author, email, date, message: message.trimEnd(), files };
}

export function refLabels(refs) {
  return (refs || "").split(", ").filter(Boolean).map(ref => {
    if (ref === "HEAD" || ref.startsWith("HEAD -> ")) return { kind: "current", name: ref.replace(/^HEAD -> (?:refs\/heads\/)?/, "") };
    if (ref.startsWith("tag: ")) return { kind: "tag", name: ref.replace(/^tag: (?:refs\/tags\/)?/, "") };
    if (ref.startsWith("refs/remotes/")) return { kind: "remote", name: ref.slice(13) };
    return { kind: "branch", name: ref.replace(/^refs\/heads\//, "") };
  }).filter(ref => ref.kind !== "remote" || !ref.name.endsWith("/HEAD"))
    .sort((a, b) => ["current", "branch", "remote", "tag"].indexOf(a.kind) - ["current", "branch", "remote", "tag"].indexOf(b.kind));
}

export function shortAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
  for (const [unit, size] of [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    if (seconds >= size || size === 1) return `${Math.floor(seconds / size)}${unit}`;
  }
}
