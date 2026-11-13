export function lineChanges(diff, lineCount) {
  const marks = new Map();
  const put = (line, mark) => {
    if (line >= 1 && line <= lineCount) marks.set(line, { ...marks.get(line), ...mark });
  };
  for (const match of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const removed = match[1] === undefined ? 1 : Number(match[1]);
    const start = Number(match[2]), added = match[3] === undefined ? 1 : Number(match[3]);
    const replaced = Math.min(removed, added);
    for (let i = 0; i < added && start + i <= lineCount; i++) put(start + i, { change: i < replaced ? "modified" : "added" });
    if (removed > added) {
      const anchor = added ? start + added - 1 : start;
      put(Math.max(1, anchor), anchor === 0 ? { deletedBefore: true } : { deletedAfter: true });
    }
  }
  return marks;
}
