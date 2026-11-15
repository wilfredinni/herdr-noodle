// A lazy file browser for the focused pane's folder, with a separate file editor.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, nextCommand, props, openOverlay } from "herdr";

import { Tasks } from "./tasks.js";
import { FileTools } from "./tools.js";
import { gitState, fileState } from "./gitState.js";
import { fileIcon } from "./fileIcons.js";
import { readFile } from "fs/promises";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const all = panes(), active = f?.pane ? all.find(p => p.pane === f.pane) : null;
  const selection = active?.mod === "changes-graph" ? shared(`github.preview.${f.tab}`)
    : ["git-file-preview", "file-editor"].includes(active?.mod) ? shared(`${active.mod}.${f.tab}`) : null;
  const pane = selection ? all.find(p => p.pane === selection.sourcePane) : active;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const workspace = pane?.cwd || selection?.root || f?.cwd || space?.folder;
  const repo = shared(`git.repository.${space?.id}`), scope = shared(`noodle.files.scope.${space?.id}`);
  return { cwd: scope !== "workspace" && repo && repo.workspace === workspace && repo.on === on ? repo.root : workspace, workspace, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    if (typeof FileTools !== "undefined") { this.tools = new FileTools(this, cx); this.tasks = new Tasks(this); }
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.git = gitState(null);
    const options = typeof props === "function" ? props() : _props;
    this.palette = Boolean(options?.palette || options?.overlay);
    if (this.palette) {
      const where = location(), repo = shared(`git.repository.${where.space}`);
      this.root = options.root || where.cwd; this.on = options.palette ? options.on : where.on; this.context = { key: key() };
      this.git = gitState(options.gitRoot || (repo?.workspace === where.workspace && repo.on === this.on ? repo.root : null));
      if (!this.root || this.on) {
        this.tools.mode = "files"; this.tools.query.focus(); this.tools.error = this.on ? "Quick Open is available for local folders only." : "Open a folder before searching for files."; return;
      }
      this.tools.show(options.mode || "files", cx); return;
    }
    if (typeof nextCommand !== "undefined") cx.spawn(async cx => { for (;;) {
      const command = await nextCommand();
      if (command === "quick-open" || command === "search") {
        this.refresh(cx);
        if (this.root && !this.on) openOverlay({ mod: "files-browser", props: { palette: true, mode: command === "search" ? "content" : "files", root: this.root, on: this.on, gitRoot: this.git.root }, kind: "dialog", frame: "none", width: 680, height: 460 });
      }
    } });
    this.treeScroll = VirtualListScrollHandle.new();
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx, this.watched && !this.on ? [".git/index"] : null));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { const paths = await watchFolder(root); if (this.current(context)) this.scheduleRefresh(cx, paths); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  scheduleRefresh(cx, paths = null) {
    if (!this.refreshQueue || this.refreshQueue.context !== this.context) this.refreshQueue = { context: this.context, paths: [], full: false };
    const queue = this.refreshQueue;
    if (!paths?.length) queue.full = true;
    else queue.paths.push(...paths);
    const sequence = this.refreshScheduled = (this.refreshScheduled || 0) + 1;
    cx.timer.after(120, cx => {
      if (sequence !== this.refreshScheduled || queue.context !== this.context) return;
      this.refreshQueue = null; this.refresh(cx, queue.full ? null : [...new Set(queue.paths)]);
    });
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  async trackedFiles(root, on, context) {
    if (context.gitRoot !== root) {
      context.gitRoot = root; context.indexPath = null; context.indexVersion = null; context.tracked = null;
    }
    let version = null;
    // shortcut: remote or unreadable indexes use ls-files until binary remote file reads are available.
    if (!on) try {
      if (!context.indexPath) {
        const path = await exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: root });
        if (path.code !== 0) throw new Error("Cannot locate Git index");
        context.indexPath = path.stdout.replace(/\r?\n$/, "");
      }
      const index = await readFile(context.indexPath), checksum = index.slice(-20);
      // index.skipHash writes a zero checksum, which cannot identify a cached index.
      if (index.length >= 32 && checksum.some(byte => byte !== 0)) version = Array.from(checksum).join(",");
    } catch {}
    if (version && version === context.indexVersion && context.tracked) return context.tracked;
    const result = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--cached", "-z"], { cwd: root, on });
    if (result.code !== 0) throw new Error("Cannot read tracked Git files");
    const tracked = gitState(root, "", result.stdout).tracked;
    context.indexVersion = version; context.tracked = tracked;
    return tracked;
  }

  refresh(cx, paths = null) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.tools) { this.tools.sequence = (this.tools.sequence || 0) + 1; this.tools.mode = null; this.tools.contextPoint = null; this.tools.contextOpen = null; this.tools.results = []; this.tools.prepared = null; this.tasks.data = null; }
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.git = gitState(null); this.file = saved?.file || null; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      this.refreshQueue = null; this.refreshQueued = false; this.refreshPaths = [];
    }
    if (!cwd) return;
    if (this.loading) {
      this.refreshQueued = true;
      this.refreshPaths = paths && this.refreshPaths ? [...new Set([...this.refreshPaths, ...paths])] : null;
      return;
    }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        const folders = ["", ...this.folders].filter(folder => !paths || paths.some(path => {
          const base = cwd.replaceAll("\\", "/").replace(/\/+$/, ""), event = path.replaceAll("\\", "/");
          const relative = event.startsWith(base + "/") ? event.slice(base.length + 1) : event === base ? "" : event;
          if (relative === ".git" || relative.startsWith(".git/")) return false;
          const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
          return !relative || folder === parent || folder === relative || folder.startsWith(relative + "/");
        }));
        for (let i = 0; i < folders.length; i += 4) {
          if (!this.current(context)) return;
          await Promise.all(folders.slice(i, i + 4).map(path => this.loadFolder(path, context)));
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        let state = gitState(null);
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const read = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
          const [status, tracked] = await Promise.all([
            exec("git", [...read, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"], { cwd: root, on }),
            this.trackedFiles(root, on, context),
          ]);
          if (status.code !== 0) throw new Error("Cannot read Git file status");
          state = gitState(root, status.stdout, tracked);
        }
        if (!this.current(context)) return;
        this.git = state; this.error = null; this.watch(cwd, cx);
        const focus = focused(), selectionKey = focus ? `file-editor.${focus.tab}` : null;
        const selection = selectionKey ? shared(selectionKey) : null;
        if (selection?.file && selection.kind === "file" && selection.root === cwd) {
          const mark = fileState(state, `${cwd}/${selection.file.path}`);
          const status = ["A", "M", "U", "D"].includes(mark) ? mark : "";
          const gitRoot = mark === "outside" || mark === "ignored" ? null : state.root;
          if (selection.file.status !== status || selection.gitRoot !== gitRoot) setShared(selectionKey, { ...selection, gitRoot, file: { ...selection.file, status } });
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) {
        this.loading = false; cx.notify();
        if (this.refreshQueued) {
          const paths = this.refreshPaths; this.refreshQueued = false; this.refreshPaths = [];
          this.scheduleRefresh(cx, paths);
        }
      } }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, options = {}) {
    if (!path || !cx || !this.current(this.context)) return;
    const focus = focused();
    if (!focus) return;
    const all = panes(), existing = all.find(p => p.tab === focus.tab && p.mod === "file-editor");
    const source = all.find(p => p.pane === focus.pane && p.terminal) || all.find(p => p.tab === focus.tab && p.terminal);
    if (!source) { this.error = "Open a terminal pane in this tab before opening a file editor"; cx.notify(); return; }
    this.file = path;
    const selectionKey = `file-editor.${focus.tab}`;
    const status = fileState(this.git, `${this.root}/${path}`);
    setShared(selectionKey, { kind: "file", navigation: options, root: this.root, on: this.on, gitRoot: status === "outside" || status === "ignored" ? null : this.git.root, file: { path, status: ["A", "M", "U", "D"].includes(status) ? status : "" }, hash: null, parent: null, hasHead: false, sourcePane: source.pane });
    if (existing) run("pane.focus", { pane: existing.pane });
    else run("pane.split", { pane: source.pane, direction: "right", mod: "file-editor", props: { selectionKey } });
    cx.notify();
  }

  treeEntries(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return out;
    const inline = this.tools?.mode === "inline";
    if (inline && this.tools.operationName !== "rename" && this.tools.inlineParent === prefix) out.push({ inline: true, depth, path: `inline-${prefix}` });
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      out.push({ entry, path, open, depth, inline: inline && this.tools.operationName === "rename" && this.tools.target === path });
      if (entry.dir && open) this.treeEntries(path, depth + 1, out);
    }
    return out;
  }

  fileRow(item, t, interactive = true) {
    const { entry, path, depth, open } = item;
    if (item.inline) return this.tools.inlineRow(depth, t);
    const mark = fileState(this.git, `${this.root}/${path}`), icon = fileIcon(entry.name, entry.dir);
    const muted = mark === "ignored" || mark === "outside";
    const color = mark === "M" ? t.ansi3 : mark === "A" ? t.ansi2 : mark === "U" || mark === "D" ? t.ansi1 : muted ? t.muted : t.foreground;
    const iconColor = muted ? t.dim : ["A", "M", "U", "D"].includes(mark) ? color : t[icon.color];
    const row = h_flex().id(`file-${path}`).w_full().h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().when(this.file === path, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .when(interactive, el => el.on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
      .child(entry.dir ? svg(`mods/files-browser/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(div().w(18).h(18).flex_none().relative()
        .child(svg(icon.path).size(16).text_color(iconColor))
        .when(Boolean(icon.badge), el => el.child(svg(icon.badge).size(9).absolute().right(0).bottom(0).bg(t.background).text_color(iconColor))))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(entry.name))
      .when(["A", "M", "U", "D"].includes(mark), el => el.child(div().text_size(11).text_color(color).child(mark)));
    return this.tools && interactive ? this.tools.context(row, path, entry.dir, t) : row;
  }

  rows(prefix, depth, out, t) {
    return out.concat(this.treeEntries(prefix, depth, []).map(item => this.fileRow(item, t)));
  }

  render(cx) {
    const t = theme();
    if (this.palette) return this.tools.palette(t, cx);
    if (key() !== this.context?.key) this.refresh(cx);
    const entries = this.treeEntries("", 0, []), virtual = entries.length > 80;
    const context = this.context, byKey = new Map(entries.map(item => [JSON.stringify([context?.key, item.path]), item]));
    const inline = entries.findIndex(item => item.inline), inlineKey = inline < 0 ? null : JSON.stringify([context?.key, entries[inline].path, this.tools.operationName]);
    if (inlineKey !== this.inlineKey) { this.inlineKey = inlineKey; if (virtual && inline >= 0) this.treeScroll.scroll_to_item(inline); }
    // The input and its handlers belong to render, not the lazy layout callback.
    const inlineHeight = this.tools?.prepared?.drafts.length ? 180 : this.tools?.error ? 64 : this.tools?.busy ? 48 : 28;
    const inlineRow = !virtual || inline < 0 ? null : this.tools.inlineRow(entries[inline].depth, t).h(inlineHeight).overflow_y_scrollbar();
    const itemKey = i => JSON.stringify([context?.key, entries[i].path]);
    const renderRow = item => item.inline ? inlineRow : this.fileRow(item, t, false);
    const lazyRows = () => v_virtual_list("files-tree-rows", entries.length,
      inline < 0 ? 28 : entries.map(item => item.inline ? inlineHeight : 28), itemKey,
      range => entries.slice(range.start, range.end).map(renderRow)).size_full().track_scroll(this.treeScroll);
    const panel = v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.tools), el => el.child(Button.new("files-scope").h(28).px(8).rounded(5).text_size(12).child(shared(`noodle.files.scope.${location().space}`) === "workspace" ? "Workspace" : "Repository").on_click((_e, cx) => { const key = `noodle.files.scope.${location().space}`; setShared(key, shared(key) === "workspace" ? "repository" : "workspace"); this.refresh(cx); if (["files", "content"].includes(this.tools.mode)) this.tools.search(cx); }))))
      .when(this.tools?.mode === "tasks", el => el.child(this.tasks.render(t, cx)))
      .when(!this.tools || this.tools.mode !== "tasks", el => el.child(v_flex().id("files-tree").flex_1().min_h(0).p(6)
        .when(!virtual, el => el.overflow_y_scrollbar().children(entries.map(item => this.fileRow(item, t))))
        .when(virtual, el => el.child(div().relative().flex_1().min_h(0)
          .child(lazyRows()
            .on_item_click((key, cx) => {
              const item = byKey.get(key);
              if (item && !item.inline && this.current(context)) item.entry.dir ? this.toggle(item.path, cx) : this.show(item.path, cx);
            })
            .on_item_secondary_click(key => {
              const item = byKey.get(key);
              if (item && !item.inline && this.tools && this.current(context)) this.tools.contextTarget = { path: item.path, directory: item.entry.dir };
            }))
          .child(Scrollbar.vertical("files-tree-rows").absolute().inset_0())))
        .when(Boolean(this.tools), el => el.child(this.tools.context(div().id("files-empty-space").flex_1().min_h(1).w_full().bg(t.background), "", true)))
        .when(Boolean(this.error) || (!this.entries.get("")?.length && this.tools?.mode !== "inline"), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))));
    return this.tools ? this.tools.contextArea(panel, t, cx) : panel;
  }
}
