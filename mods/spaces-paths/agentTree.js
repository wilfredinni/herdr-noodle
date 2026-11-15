// Keep pane agents and their live sub-agents in one tree, without duplicate rows.
const clean = value => (value ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();
export function agentLabel(agent) {
  const title = clean(agent.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((agent.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  if (agent.tab_named && agent.tab_name && agent.tab_name !== agent.program?.name && agent.tab_name.toLowerCase() !== agent.program?.key) return agent.tab_name;
  return title && !path && !title.includes("@") && title !== agent.address && title !== agent.program?.name && title.toLowerCase() !== agent.program?.key
    ? title : agent.name || agent.program?.name || agent.app || agent.address;
}

export function agentTree(list, all) {
  const listed = new Map(list.map(a => [a.address, a]));
  const live = all.filter(a => a.state === "live");
  const seen = new Set(), out = [];
  function visit(agent, depth, parent = null) {
    if (seen.has(agent.address)) return;
    seen.add(agent.address);
    const own = listed.get(agent.address);
    const entry = { ...agent, ...own, space: own?.space ?? parent?.space, depth,
      listed: Boolean(own), parent: parent?.address ?? null,
      status: own?.status ?? (agent.status === "error" ? "blocked" : agent.status === "done" ? "idle" : agent.status) };
    entry.label = agentLabel(entry);
    out.push(entry);
    for (const child of live.filter(a => a.parent === agent.address)) {
      if (listed.has(child.address) && (listed.get(child.address).pinned || listed.get(child.address).space !== entry.space)) continue;
      visit(child, depth + 1, entry);
    }
  }
  const nested = new Set();
  for (const agent of list) {
    if (agent.pinned) continue;
    const chain = new Set([agent.address]);
    let parent = live.find(t => t.address === agent.address)?.parent;
    while (parent && !chain.has(parent)) {
      chain.add(parent);
      if (listed.get(parent)?.space === agent.space) { nested.add(agent.address); break; }
      parent = live.find(t => t.address === parent)?.parent;
    }
  }
  const roots = list.filter(a => !nested.has(a.address));
  roots.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  roots.forEach(a => visit(a, 0));
  // Inconsistent parent reports must not hide agents or recurse forever.
  list.forEach(a => { if (!seen.has(a.address)) visit(a, 0); });
  return out;
}

export function filterAgents(entries, query, spaceMatches = false) {
  if (!query || spaceMatches) return entries;
  const keep = new Set();
  const byAddress = new Map(entries.map(a => [a.address, a]));
  for (const a of entries) {
    if (!`${a.label} ${a.program?.name ?? ""} ${a.app ?? ""}`.toLowerCase().includes(query)) continue;
    let current = a;
    while (current && !keep.has(current.address)) { keep.add(current.address); current = byAddress.get(current.parent); }
  }
  return entries.filter(a => keep.has(a.address));
}
