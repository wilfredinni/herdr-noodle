import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, Tabs, Tab, Button, Checkbox } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run, shared, setShared } from "herdr";
import { GRAPH_ARGS, HISTORY_ARGS, GRAPH_ROW_HEIGHT, graphRows, COMMIT_FORMAT, commitDetail, refLabels, shortAge } from "./graph.js";
import { GitToolbar } from "./gitToolbar.js";
import { showGitError } from "./gitError.js";
import { FileActions } from "./fileActions.js";
import { CommitGenerator } from "./commitGenerator.js";
import { Repositories } from "./repositories.js";
import { StashPanel } from "./stashPanel.js";

function sourceLocation() {
  const space = spaces().find((s) => s.active), f = focused();
  const all = panes(), active = f?.pane ? all.find(p => p.pane === f.pane) : null;
  const selection = active?.mod === "git-file-preview" ? shared(`git-file-preview.${f.tab}`) : null;
  const pane = selection ? all.find(p => p.pane === selection.sourcePane) : active;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
function workspace(source = sourceLocation()) {
  const space = spaces().find(s => s.active);
  return { id: space?.id, folder: source.cwd, on: source.on };
}
function location() {
  const source = sourceLocation(), w = workspace(source), selected = shared(`git.repository.${w.id}`);
  return { cwd: selected?.workspace === w.folder && selected?.on === w.on && typeof selected?.root === "string" ? selected.root : source.cwd, on: source.on };
}
const key = () => JSON.stringify(location());
const draftKey = (root, on) => JSON.stringify({ root, on });
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
function upstreamState(status) {
  const header = status.split("\0", 1)[0], match = /^## .+?\.\.\.(.+?)(?: \[([^\]]+)\])?$/.exec(header);
  if (!match || match[2] === "gone") return null;
  return { upstream: match[1], ahead: Number(/ahead (\d+)/.exec(match[2] || "")?.[1] || 0), behind: Number(/behind (\d+)/.exec(match[2] || "")?.[1] || 0) };
}
export default class Changes extends View {
  init(_props, cx) {
    this.drafts = new Map(); this.repositories = new Repositories(this, workspace, cx);
    this.view = "changes"; this.graph = []; this.graphError = null; this.selectedCommit = null; this.detail = null; this.detailError = null;
    this.history = []; this.historyError = null; this.historyLoading = false;
    this.files = []; this.message = ""; this.messageRevision = 0; this.generator = new CommitGenerator(this, key, cx); this.handle = cx.focus_handle();
    this.branch = null; this.head = ""; this.sync = null; this.gitToolbar = new GitToolbar(this, key, cx);
    this.fileActions = new FileActions(this, key, cx); this.stash = new StashPanel(this); this.historyPath = null; this.collapsed = {};
    this.input = TextareaState.new({ placeholder: "Write a commit message…", rows: 3 });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value(); this.messageRevision++;
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    this.repositories.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    const changedContext = context !== this.context;
    if (context !== this.context) {
      if (this.root) this.drafts.set(draftKey(this.root, this.on), this.message);
      this.selectedCommit = null; this.detail = null; this.detailError = null;
      this.graph = []; this.graphError = null; this.graphContext = null; this.graphLoading = false;
      this.history = []; this.historyError = null; this.historyLoading = false; this.historyVersion = (this.historyVersion ?? 0) + 1;
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.branch = null; this.head = ""; this.sync = null; this.gitToolbar.reset();
      this.fileActions.reset(); this.stash.reset(); this.historyPath = null; this.collapsed = {};
      this.message = ""; this.messageRevision++; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    const revision = this.messageRevision;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) {
          this.selectedCommit = null; this.detail = null; this.graph = []; this.graphError = null; this.history = []; this.historyError = null; this.root = null; this.branch = null; this.head = ""; this.sync = null; this.files = []; this.open = null;
          this.error = this.repositories.rows.length > 1 ? "Select a repository above" : "No Git repository found in this folder";
          if (this.repositories.rows.length === 1 && this.repositories.rows[0].root !== cwd) this.repositories.choose(this.repositories.rows[0], cx);
          return;
        }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--branch", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const branch = await git(["symbolic-ref", "--quiet", "HEAD"]);
        if (branch.code !== 0 && branch.code !== 1) throw new Error(branch.stderr || "Cannot read current branch");
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(entry => entry && !entry.startsWith("## "));
        for (const entry of entries) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, indexStatus: xy[0], worktreeStatus: xy[1], staged: !fresh && xy[0] !== " " && xy[0] !== "?", unstaged: fresh || xy[1] !== " ", ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.branch = branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : null;
        this.head = head.code === 0 ? head.stdout.trim() : "";
        this.sync = upstreamState(status.stdout);
        if (changedContext && revision === this.messageRevision) {
          this.message = this.drafts.get(draftKey(root, on)) || ""; this.messageRevision++; this.input.set_value(this.message);
        }
        this.repositories.update(root, this.branch, files, this.sync);
        this.watch(root, cx);
        if (this.view === "graph") await this.loadGraph(context);
        if (this.view === "history") await this.loadHistory(context);
        if (this.view === "stashes") await this.stash.refresh();
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async loadGraph(context) {
    if (!this.root || context !== key()) return;
    this.graphContext = context; this.graphLoading = true; this.graphError = null;
    const version = this.graphVersion = (this.graphVersion ?? 0) + 1;
    try {
      const result = await exec("git", [...READ, ...GRAPH_ARGS], { cwd: this.root, on: this.on });
      if (context !== key() || version !== this.graphVersion) return;
      if (result.code !== 0) throw new Error(result.stderr || "Cannot load Git history");
      this.graph = graphRows(result.stdout);
    } catch (error) { if (context === key() && version === this.graphVersion) this.graphError = String(error); }
    finally { if (this.graphContext === context && version === this.graphVersion) this.graphLoading = false; }
  }

  async loadHistory(context) {
    if (!this.root || context !== key()) return;
    const version = this.historyVersion = (this.historyVersion ?? 0) + 1, path = this.historyPath;
    this.historyLoading = true; this.historyError = null;
    try {
      if (!this.hasHead) { this.history = []; return; }
      const result = await exec("git", [...READ, ...HISTORY_ARGS, ...(path ? ["--", path] : [])], { cwd: this.root, on: this.on });
      if (context !== key() || version !== this.historyVersion) return;
      if (result.code !== 0) throw new Error(result.stderr || "Cannot load Git history");
      this.history = graphRows(result.stdout);
    } catch (error) { if (context === key() && version === this.historyVersion) this.historyError = String(error); }
    finally { if (version === this.historyVersion) this.historyLoading = false; }
  }

  showFileHistory(path, cx) {
    if (!this.root || this.context !== key()) return;
    this.historyPath = path; this.history = []; this.view = "history"; this.closeDetail(cx);
    const context = this.context;
    cx.spawn(async cx => { await this.loadHistory(context); cx.notify(); }); cx.notify();
  }

  selectView(view, cx) {
    if (view !== this.view) this.closeDetail(cx);
    this.view = view;
    if (this.root && !this.loading) {
      const context = this.context;
      if (view === "graph") cx.spawn(async cx => { await this.loadGraph(context); cx.notify(); });
      if (view === "history") cx.spawn(async cx => { await this.loadHistory(context); cx.notify(); });
      if (view === "stashes") cx.spawn(async cx => { await this.stash.refresh(); cx.notify(); });
    }
    cx.notify();
  }

  pickCommit(row, cx) {
    if (!this.root || this.context !== key()) return;
    this.selectedCommit = row.fullHash; this.detail = null; this.detailError = null;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const git = async args => {
          const result = await exec("git", [...READ, ...args], { cwd: root, on });
          if (result.code !== 0) throw new Error(result.stderr || "Cannot load commit");
          return result.stdout;
        };
        const metadata = await git(["show", "--no-patch", `--format=${COMMIT_FORMAT}`, row.fullHash, "--"]);
        const parents = metadata.split("\0")[1].split(" ").filter(Boolean);
        const base = ["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "--no-ext-diff", "--no-textconv"];
        const revisions = [...parents.slice(0, 1), row.fullHash, "--"];
        const [statuses, stats] = await Promise.all([
          git([...base, "--name-status", "-z", ...revisions]),
          git([...base, "--numstat", "-z", ...revisions]),
        ]);
        if (key() === context && this.selectedCommit === row.fullHash) {
          this.detail = commitDetail(metadata, statuses, stats);
          const file = this.detail.files.find(file => file.path === this.historyPath) || this.detail.files[0];
          if (file) this.openFile(file, this.detail, cx);
        }
      } catch (error) { if (key() === context && this.selectedCommit === row.fullHash) this.detailError = String(error); }
      cx.notify();
    });
    cx.notify();
  }

  closeDetail(cx) {
    this.selectedCommit = null; this.detail = null; this.detailError = null; cx.notify();
  }

  commitView(t) {
    const detail = this.detail;
    const metadata = (label, value, mono = false) => h_flex().gap(10).min_w(0)
      .child(div().w(54).flex_none().text_color(t.muted).child(label))
      .child(div().flex_1().min_w(0).truncate().tooltip(value).when(mono, el => el.font_family(settings().font_family ?? "JetBrains Mono")).child(value));
    return v_flex().h(290).max_h("55%").flex_none().min_h(0).border_t(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().px(12).items_center().justify_between().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().child(`Commit ${this.selectedCommit.slice(0, 8)}`))
        .child(Button.new("close-commit").size(24).flex().items_center().justify_center().rounded(4).hover(el => el.bg(t.hover))
          .accessibility_label("Close commit details").tooltip("Close commit details").on_click((_e, cx) => this.closeDetail(cx)).child(svg("mods/pane/close.svg").size(12))))
      .child(v_flex().id("commit-detail").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(8).text_size(11)
        .when(!detail, el => el.child(div().text_color(this.detailError ? t.ansi1 : t.muted).child(this.detailError || "Loading commit…")))
        .when(Boolean(detail), el => el
          .child(div().text_size(12).font_semibold().child(detail.message))
          .child(metadata("Commit", detail.hash, true))
          .child(metadata("Parents", detail.parents.map(hash => hash.slice(0, 8)).join(", ") || "None (root commit)", true))
          .child(metadata("Author", `${detail.author} <${detail.email}>`))
          .child(metadata("Date", detail.date.replace("T", " ")))
          .child(h_flex().mt(4).gap(8).text_color(t.muted)
            .child(div().child(`${detail.files.length} ${detail.files.length === 1 ? "file" : "files"}`))
            .child(div().text_color(t.ansi2).child(`+${detail.files.reduce((n, f) => n + (f.add || 0), 0)}`))
            .child(div().text_color(t.ansi1).child(`−${detail.files.reduce((n, f) => n + (f.del || 0), 0)}`)))
          .when(detail.parents.length > 1, e => e.child(div().text_color(t.muted).child("Changes against first parent")))
          .children(detail.files.slice(0, 1000).map(file => Button.new(`commit-file-${file.path}`).h_flex().w_full().h(26).flex_none().gap(8).min_w(0).px(4).rounded(4).cursor_pointer().accessibility_label(`Open ${file.path}`).hover(e => e.bg(t.hover)).on_click((_e, cx) => this.openFile(file, detail, cx))
            .child(div().w(14).flex_none().text_color(file.status === "D" ? t.ansi1 : file.status === "A" ? t.ansi2 : t.blocked).child(file.status))
            .child(div().flex_1().min_w(0).truncate().tooltip(file.path).when(file.status === "D", el => el.line_through().text_color(t.muted)).child(file.path))
            .when(file.add > 0, e => e.child(div().text_color(t.ansi2).child(`+${file.add}`)))
            .when(file.del > 0, e => e.child(div().text_color(t.ansi1).child(`−${file.del}`)))
            .when(file.binary, e => e.child(div().text_color(t.muted).child("Binary")))))
          .when(detail.files.length > 1000, e => e.child(div().text_color(t.muted).child("Showing the first 1,000 files")))));
  }

  graphRow(row, width, t) {
    const height = GRAPH_ROW_HEIGHT, lane = div().w(width).h(height).flex_none().relative();
    const colors = [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6];
    for (const edge of width ? row.edges : []) {
      const x = edge.from * 12 + 8, to = edge.to * 12 + 8, mid = (edge.top + edge.bottom) / 2;
      const path = PathBuilder.stroke(1.2).move_to(x, edge.top);
      if (x === to) path.line_to(to, edge.bottom);
      else path.cubic_bezier_to(to, edge.bottom, x, mid, to, mid);
      lane.child(window.paint_path(path.build(), colors[edge.color % colors.length]).absolute().inset_0());
    }
    lane.child(div().absolute().left(row.lane * 12 + 5).top(height / 2 - 3).size(6).rounded_full().bg(colors[row.color % colors.length]));
    const merge = row.parents.split(" ").length > 1;
    return Button.new(`commit-${row.fullHash}`).h_flex().w_full().h(height).flex_none().items_center().gap(8).px(8).text_size(12).font_normal()
      .bg(this.selectedCommit === row.fullHash ? t.selected : t.background).cursor_pointer()
      .accessibility_label(`Show commit ${row.hash}: ${row.subject}`).tooltip(`${row.subject}\n${row.hash} · ${row.author} · ${row.age}${row.refs ? "\n" + row.refs : ""}`)
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.pickCommit(row, cx))
      .when(width > 0, el => el.child(lane))
      .child(h_flex().flex_1().min_w(0).items_center().gap(6)
        .when(width > 0 && Boolean(row.refs), el => el.child(h_flex().flex_none().max_w("55%").min_w(0).overflow_hidden().gap(4).items_center()
          .children(refLabels(row.refs).map(ref => {
            const color = ref.kind === "tag" ? t.ansi3 : ref.kind === "branch" ? t.ansi2 : t.ansi4;
            return h_flex().h(16).max_w(150).min_w(0).flex_none().tooltip(ref.name).px(4).gap(3).items_center().rounded(3).border_1().border_color(color)
              .bg(ref.kind === "current" ? color : t.background).text_color(ref.kind === "current" ? t.background : color)
              .font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
              .child(svg(`mods/changes-graph/${ref.kind}.svg`).size(10).flex_none())
              .child(div().min_w(0).truncate().child(ref.name));
          }))))
        .child(div().flex_1().min_w(0).truncate().text_color(merge ? t.muted : t.foreground).child(row.subject)))
      .child(div().w(32).flex_none().text_right().text_color(t.muted).child(shortAge(row.timestamp)))
      .child(div().w(100).flex_none().truncate().text_color(t.muted).child(row.author))
      .child(div().w(66).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted).child(row.hash));
  }

  graphView(t, history = false) {
    const rows = history ? this.history : this.graph;
    const error = history ? this.historyError : this.graphError, loading = history ? this.historyLoading : this.graphLoading;
    const id = history ? "git-history" : "git-graph";
    const width = history ? 0 : Math.max(38, ...rows.map(row => row.lanes * 12 + 12));
    const empty = error || this.error || (!this.root ? "Open a Git folder" : loading || this.loading ? "Loading history…" : "No commits yet");
    return v_flex().flex_1().min_h(0)
      .when(history && Boolean(this.historyPath), el => el.child(h_flex().h(32).px(14).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
        .child(svg("mods/changes-graph/file.svg").size(13).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(11).tooltip(this.historyPath).child(this.historyPath))
        .child(Button.new("clear-file-history").size(24).flex().items_center().justify_center().rounded(4).bg("#00000000").text_color(t.muted)
          .accessibility_label("Show all history").on_click((_e, cx) => { this.historyPath = null; this.selectView("history", cx); }).child(svg("mods/pane/close.svg").size(12)))))
      .child(div().flex_1().min_h(0).relative()
        .child(div().id(`${id}-x`).absolute().inset_0().overflow_x_scroll()
          .child(v_flex().w_full().min_w(history ? 500 : Math.max(560, width + 440)).h_full()
            .child(h_flex().h(24).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
              .when(!history, el => el.child(div().w(width).flex_none().child("Graph")))
              .child(div().flex_1().min_w(0).child("Description"))
              .child(div().w(32).flex_none().text_right().child("Date"))
              .child(div().w(100).flex_none().child("Author"))
              .child(div().w(66).flex_none().child("Commit")))
            .child(div().flex_1().min_h(0).relative()
              .child(v_flex().id(`${id}-list`).absolute().inset_0().overflow_y_scroll()
                .when(!history && this.files.length > 0, el => el.child(Button.new("graph-uncommitted").h_flex().h(24).px(14).gap(8).flex_none().items_center().bg("#00000000").text_size(12).text_color(t.muted)
                  .accessibility_label(`Show ${this.files.length} uncommitted changes`).hover(e => e.bg(t.hover)).on_click((_e, cx) => this.selectView("changes", cx))
                  .child(svg("mods/changes-graph/changes.svg").size(14)).child(`Uncommitted changes (${this.files.length})`)))
                .children(rows.map(row => this.graphRow(row, width, t)))
                .when(!rows.length, el => el.child(div().p(14).text_size(12).text_color(t.muted).child(empty))))
              .child(Scrollbar.vertical(`${id}-list`).absolute().inset_0()))))
        .child(Scrollbar.horizontal(`${id}-x`).absolute().inset_0()))
      .when(Boolean(this.selectedCommit), el => el.child(this.commitView(t)))
      .when(Boolean(error) && rows.length > 0, el => el.child(div().px(14).py(8).text_size(12).text_color(t.ansi1).child(error)));
  }

  openFile(file, commit, cx, options = {}) {
    const focus = focused();
    if (!focus || !this.root || this.context !== key()) return;
    const all = panes(), existing = all.find(p => p.tab === focus.tab && p.mod === "git-file-preview");
    const source = all.find(p => p.pane === focus.pane && p.terminal) || all.find(p => p.tab === focus.tab && p.terminal);
    if (!source) { this.note = "Open a terminal pane in this tab before opening a file preview"; cx.notify(); return; }
    const selectionKey = `git-file-preview.${focus.tab}`;
    setShared(selectionKey, { root: this.root, on: this.on, file, hash: commit?.hash ?? null, parent: commit?.parents[0] ?? null, hasHead: this.hasHead, sourcePane: source.pane, ...options });
    if (existing) run("pane.focus", { pane: existing.pane });
    else run("pane.split", { pane: source.pane, direction: "right", mod: "git-file-preview", props: { selectionKey } });
    if (!commit) { this.open = file.path; this.openMode = options.diffMode || "all"; }
    this.note = null; cx.notify();
  }

  fileCheckbox(id, checked, label, change, t, mixed, disabled) {
    return div().size(22).flex_none().flex().items_center().justify_center().tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .child(Checkbox.new(id).size(14).p(0).flex().items_center().justify_center().rounded(3).border_1()
        .border_color(checked || mixed ? t.accent : t.input).bg(checked || mixed ? t.accent : "#00000000").text_color(t.accent_foreground)
        .checked(checked).disabled(disabled).accessibility_label(label).focus(s => s.border_color(t.foreground))
        .when(disabled, el => el.opacity(0.5)).on_change((value, cx) => { cx.stop_propagation(); change(value, cx); })
        .when(checked && !mixed, el => el.child(svg("mods/workspace-chrome/check.svg").size(10)))
        .when(mixed, el => el.child(div().w(7).h(1.5).bg(t.accent_foreground))));
  }

  changeRows(t, cx, disabled) {
    const snapshot = this.fileActions.snapshot(), files = this.files.slice(0, 1000);
    const groups = [["staged", "Staged changes", files.filter(file => file.staged && file.status !== "U")],
      ["unstaged", "Changes", files.filter(file => file.unstaged ?? !file.staged)]];
    return v_flex().gap(2)
      .when(this.files.some(file => file.status === "U"), el => el.child(h_flex().px(8).py(10).gap(8).text_size(12).text_color(t.ansi1)
        .child(svg("mods/changes-graph/warning.svg").size(14).flex_none())
        .child(div().child("Resolve conflicts in your editor, then stage the resolved files before committing."))))
      .children(groups.filter(([, , entries]) => entries.length).map(([mode, title, entries]) => v_flex().flex_none()
        .child(h_flex().h(30).flex_none().items_center().gap(4)
          .child(Button.new(`toggle-${mode}`).h_flex().flex_1().min_w(0).h(28).px(8).gap(7).items_center().justify_start().bg("#00000000").text_size(11).font_normal().text_color(t.muted)
            .accessibility_label(`${this.collapsed[mode] ? "Expand" : "Collapse"} ${title}`).focus(el => el.border_color(t.accent))
            .on_click((_e, cx) => { this.collapsed[mode] = !this.collapsed[mode]; cx.notify(); })
            .child(svg(`mods/changes-graph/${this.collapsed[mode] ? "expand" : "chevron"}.svg`).size(10))
            .child(div().font_semibold().child(title)).child(div().child(String(entries.length))))
          .child(Button.new(`stage-group-${mode}`).size(28).flex_none().flex().items_center().justify_center().rounded(4).bg("#00000000").text_color(t.muted)
            .disabled(disabled).accessibility_label(mode === "staged" ? "Unstage all staged files" : "Stage all working changes").tooltip(mode === "staged" ? "Unstage all" : "Stage all")
            .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => this.fileActions.stageFiles(entries.map(file => file.path), mode !== "staged", cx, snapshot))
            .child(svg(`mods/changes-graph/${mode === "staged" ? "minus" : "plus"}.svg`).size(13))))
        .when(!this.collapsed[mode], el => el.children(entries.map(file => {
          const parts = file.path.split("/"), name = parts.pop(), id = `${mode}-${file.path}:${file.fresh ? "untracked" : "tracked"}`;
          const status = (mode === "staged" ? file.indexStatus : file.worktreeStatus)?.trim().replace("?", "A") || file.status;
          const row = h_flex().id(`change-${id}`).h(32).flex_none().px(8).gap(8).items_center().rounded(4).cursor_pointer()
            .bg(this.open === file.path && this.openMode === mode ? t.selected : "#00000000").hover(el => el.bg(t.hover))
            .on_click((_e, cx) => this.openFile(file, null, cx, { diffMode: mode }))
            .child(div().w(12).flex_none().text_size(11).text_color(status === "A" ? t.ansi2 : status === "D" || status === "U" ? t.ansi1 : t.ansi3).child(status))
            .child(svg("mods/changes-graph/file.svg").size(13).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(status === "D" ? t.muted : t.foreground).when(status === "D", el => el.line_through()).tooltip(file.path).child(name))
            .child(div().max_w("45%").min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(parts.join("/")).child(parts.join("/")))
            .child(this.fileActions.rowMenu(file, mode, t, cx, disabled))
            .child(this.fileCheckbox(`select-file-${id}`, mode === "staged", `${mode === "staged" ? "Unstage" : "Stage"} ${file.path}`, (checked, cx) => this.fileActions.stageFiles([file.path], checked, cx, snapshot), t, false, disabled || file.status === "U"));
          return this.fileActions.row(file, row, t, cx, mode);
        })))));
  }

  commit(cx) {
    const paths = this.files.filter(f => f.staged).map(f => f.path);
    if (!this.files.length || !this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const allPaths = this.files.map(f => f.path).sort();
    const root = this.root, on = this.on, context = this.context, message = this.message.trim(), expectedBranch = this.branch, expectedHead = this.head;
    this.busy = true; this.committing = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const ask = args => exec("git", [...READ, ...args], { cwd: root, on });
        const branch = await ask(["symbolic-ref", "--quiet", "HEAD"]);
        if (branch.code !== 0 && branch.code !== 1) throw new Error(branch.stderr || "Cannot verify current branch");
        const branchName = branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : null;
        const head = await ask(["rev-parse", "--verify", "--quiet", "HEAD"]);
        if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr || "Cannot verify HEAD");
        if (key() !== context || branchName !== expectedBranch || (head.code === 0 ? head.stdout.trim() : "") !== expectedHead)
          throw new Error("Repository or branch changed. Review your file selection and try again.");
        const conflicts = await ask(["diff", "--name-only", "--diff-filter=U", "-z"]);
        if (conflicts.code !== 0) throw new Error(conflicts.stderr || "Cannot check for conflicts");
        if (conflicts.stdout) throw new Error("Resolve merge conflicts before committing.");
        const staged = await ask(["diff", "--cached", "--name-only", "-z"]);
        if (staged.code !== 0) throw new Error(staged.stderr || "Cannot read staged files");
        const stagedPaths = staged.stdout.split("\0").filter(Boolean).sort();
        if (JSON.stringify(stagedPaths) !== JSON.stringify([...paths].sort())) throw new Error("Staged files changed. Review the changes and try again.");
        if (key() !== context) throw new Error("Repository changed. Review your file selection and try again.");
        if (!paths.length) {
          const status = await ask(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
          if (status.code !== 0) throw new Error(status.stderr || "Cannot read changed files");
          const currentPaths = status.stdout.split("\0").filter(Boolean).map(entry => entry.slice(3)).sort();
          if (JSON.stringify(currentPaths) !== JSON.stringify(allPaths)) throw new Error("The file list changed. Review it and try again.");
          const added = await exec("git", ["--literal-pathspecs", "-c", "core.fsmonitor=false", "add", "-A", "--", ...allPaths], { cwd: root, on });
          if (added.code !== 0) throw new Error((added.stderr || added.stdout || "Cannot stage changed files").trim());
          if (key() !== context) throw new Error("Repository changed. Review the staged changes before committing.");
        }
        const committed = await exec("git", ["commit", "-m", message], { cwd: root, on });
        if (committed.code !== 0) throw new Error((committed.stderr || committed.stdout).trim());
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) showGitError("Commit", e, { root, branch: this.branch }); }
      finally { this.busy = false; this.committing = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  render(cx) {
    this.repositories.refresh(cx);
    const current = key() === this.context;
    if (!current) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const selectedCount = this.files.filter(f => f.staged).length, conflicts = this.files.some(file => file.status === "U");
    const hasMessage = Boolean(this.files.length && this.message.trim() && this.root && current);
    const enabled = hasMessage && !this.busy && !this.loading && !conflicts;
    const disabled = this.busy || this.loading || !current;
    const name = this.root?.split(/[\\/]/).filter(Boolean).pop() || "repository";
    const summary = this.view === "changes" ? `${this.files.length} files` : this.view === "stashes" ? `${this.stash.entries.length} saved ${this.stash.entries.length === 1 ? "stash" : "stashes"}` : "";
    return v_flex().id("changes").size_full().min_w(0).min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.view !== "changes" && this.selectedCommit) { this.closeDetail(cx); cx.stop_propagation(); }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .when(this.repositories.rows.length > 1, el => el.child(this.repositories.render(t, cx)))
      .child(this.gitToolbar.repositoryHeader(t, cx))
      .child(Tabs.new("git-views").h_flex().h(38).flex_none().px(10).gap(8).border_b(1).border_color(t.border).bg("#00000000")
        .children([["changes", "Changes"], ["history", "History"], ["graph", "Graph"], ["stashes", "Stash"]].map(([view, label]) =>
          Tab.new(`git-view-${view}`).h_flex().h(38).px(5).gap(6).flex_none().items_center().justify_center().text_size(12).font_normal().selected(this.view === view)
            .accessibility_label(label).bg("#00000000").text_color(this.view === view ? t.foreground : t.muted).border_b(this.view === view ? 2 : 0).border_color(t.accent)
            .focus(el => el.bg(t.raised)).on_click((_e, cx) => this.selectView(view, cx))
            .child(svg(`mods/changes-graph/${view}.svg`).size(13)).child(label))))
      .when(this.view !== "history", panel => panel.child(h_flex().h(36).flex_none().px(14).gap(6).items_center().text_size(11).text_color(t.muted)
        .when(Boolean(summary), el => el.child(div().child(summary)))
        .when(this.view === "changes", el => el.child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`)))
        .child(div().flex_1())
        .when(this.view === "changes", el => el.child(this.fileActions.header(t, cx)))
        .when(this.view === "graph", el => el.child(div().child("All refs")))))
      .when(this.view === "history" || this.view === "graph", el => el.child(this.graphView(t, this.view === "history")))
      .when(this.view === "stashes", el => el.child(this.stash.render(t, cx)))
      .when(this.view === "changes", panel => panel
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().px(6).pb(8)
            .child(this.changeRows(t, cx, disabled))
            .when(!this.files.length, el => el.child(v_flex().px(16).py(32).gap(8).items_center().text_color(t.muted)
              .when(Boolean(this.root && !this.error && !this.loading), el => el.child(svg("mods/workspace-chrome/check.svg").size(24)))
              .child(div().font_semibold().text_size(12).child(this.error || (this.loading ? "Loading changes…" : this.root ? "All changes committed" : "Open a Git folder")))
              .when(Boolean(this.root && !this.error && !this.loading), el => el.child(div().text_size(12).child(`${name} has a clean working tree.`))
                .child(Button.new("clean-view-history").h(28).px(10).rounded(5).border_1().border_color(t.border).bg(t.raised).text_size(12).text_color(t.foreground)
                  .accessibility_label("View history").on_click((_e, cx) => this.selectView("history", cx)).child("View history"))))))
          .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
        .when(this.limited, el => el.child(div().px(14).py(6).text_size(11).text_color(t.muted).child("Showing the first 1,000 changed files"))))
      .when(Boolean(this.note), el => el.child(div().px(14).py(8).text_size(12).text_color(t.ansi1).child(this.note)))
      .child(this.gitToolbar.render(t, cx).border_t(1).border_color(t.border))
      .child(v_flex().flex_none().p(14).gap(10).border_t(1).border_color(t.border).bg(t.canvas)
        .child(div().id("commit-message").w_full().min_w(0).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.input).w_full().h(54).text_size(12).line_height("18px").text_color(t.foreground).accessibility_label("Commit message")))
        .child(h_flex().w_full().items_center().justify_end().gap(8)
          .child(Button.new("commit").h(28).px(10).flex().items_center().rounded(5).border_1().border_color(t.border).bg(t.raised).text_color(hasMessage ? t.foreground : t.dim).text_size(12).font_normal().disabled(!enabled)
            .accessibility_label(selectedCount ? `Commit ${selectedCount} staged files` : "Commit all changes").tooltip(selectedCount ? "Commit staged content only" : "Stage and commit all reviewed changes")
            .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => this.commit(cx))
            .child(this.committing ? "Committing…" : selectedCount ? `Commit ${selectedCount} ${selectedCount === 1 ? "file" : "files"}` : "Commit all"))
          .child(this.generator.render(t, cx))));
  }
}
