import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, Tabs, Tab, Button, Checkbox } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run, shared, setShared } from "herdr";
import { GRAPH_ARGS, HISTORY_ARGS, GRAPH_LIMIT, GRAPH_ROW_HEIGHT, graphRows, COMMIT_FORMAT, commitDetail, refLabels, shortAge } from "./graph.js";
import { GitToolbar } from "./gitToolbar.js";
import { showGitError } from "./gitError.js";
import { FileActions } from "./fileActions.js";
import { CommitGenerator } from "./commitGenerator.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const all = panes(), active = f?.pane ? all.find(p => p.pane === f.pane) : null;
  const selection = active?.mod === "git-file-preview" ? shared(`git-file-preview.${f.tab}`) : null;
  const pane = selection ? all.find(p => p.pane === selection.sourcePane) : active;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export default class Changes extends View {
  init(_props, cx) {
    this.view = "changes"; this.graph = []; this.graphError = null; this.selectedCommit = null; this.detail = null; this.detailError = null;
    this.history = []; this.historyError = null; this.historyLoading = false;
    this.files = []; this.message = ""; this.messageRevision = 0; this.generator = new CommitGenerator(this, key, cx); this.handle = cx.focus_handle();
    this.branch = null; this.head = ""; this.gitToolbar = new GitToolbar(this, key, cx);
    this.fileActions = new FileActions(this, key, cx); this.historyPath = null;
    this.input = TextareaState.new({ placeholder: "Commit message", rows: 3 });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value(); this.messageRevision++;
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
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
    if (context !== this.context) {
      this.selectedCommit = null; this.detail = null; this.detailError = null;
      this.graph = []; this.graphError = null; this.graphContext = null; this.graphLoading = false;
      this.history = []; this.historyError = null; this.historyLoading = false; this.historyVersion = (this.historyVersion ?? 0) + 1;
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.branch = null; this.head = ""; this.gitToolbar.reset();
      this.fileActions.reset(); this.historyPath = null;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.selectedCommit = null; this.detail = null; this.graph = []; this.graphError = null; this.history = []; this.historyError = null; this.root = null; this.branch = null; this.head = ""; this.files = []; this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
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
        const entries = status.stdout.split("\0").filter(Boolean);
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
        this.watch(root, cx);
        if (this.view === "graph") await this.loadGraph(context);
        if (this.view === "history") await this.loadHistory(context);
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
          if (this.view === "history" && file) this.openFile(file, this.detail, cx);
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
              .font_family(settings().font_family ?? "JetBrains Mono").text_size(10)
              .child(svg(`mods/changes-graph/${ref.kind}.svg`).size(10).flex_none())
              .child(div().min_w(0).truncate().child(ref.name));
          }))))
        .child(div().flex_1().min_w(0).truncate().text_color(merge ? t.muted : t.foreground).child(row.subject)))
      .child(div().w(32).flex_none().text_right().text_color(t.muted).child(shortAge(row.timestamp)))
      .child(div().w(100).flex_none().truncate().text_color(t.muted).child(row.author))
      .child(div().w(66).flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(10).text_color(t.muted).child(row.hash));
  }

  graphView(t, history = false) {
    const rows = history ? this.history : this.graph, count = rows.length;
    const error = history ? this.historyError : this.graphError, loading = history ? this.historyLoading : this.graphLoading;
    const id = history ? "git-history" : "git-graph";
    const scope = history ? this.historyPath || this.branch || "HEAD" : "all branches";
    const width = history ? 0 : Math.max(38, ...rows.map(row => row.lanes * 12 + 12));
    const empty = error || this.error || (!this.root ? "No folder" : loading || this.loading
      ? history ? "Loading history…" : "Loading Git graph…"
      : history && this.historyPath ? "No commits for this file" : "No commits yet");
    return v_flex().flex_1().min_h(0)
      .child(div().flex_1().min_h(0).relative()
        .child(div().id(`${id}-x`).absolute().inset_0().overflow_x_scroll()
          .child(v_flex().w_full().min_w(history ? 500 : 560).h_full()
            .child(h_flex().h(24).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
              .when(!history, el => el.child(div().w(width).flex_none().child("Graph")))
              .child(div().flex_1().min_w(0).child("Description"))
              .child(div().w(32).flex_none().text_right().child("Date"))
              .child(div().w(100).flex_none().child("Author"))
              .child(div().w(66).flex_none().child("Commit")))
            .child(div().flex_1().min_h(0).relative()
              .child(v_flex().id(`${id}-list`).absolute().inset_0().overflow_y_scroll()
                .when(!history && this.files.length > 0, el => el.child(Button.new("graph-uncommitted").h_flex().w_full().h(GRAPH_ROW_HEIGHT).flex_none().px(8).gap(8).items_center().text_size(12).text_color(t.muted).cursor_pointer()
                  .accessibility_label(`Show ${this.files.length} uncommitted changes`).hover(e => e.bg(t.hover)).on_click((_e, cx) => this.selectView("changes", cx))
                  .child(div().w(width).h(GRAPH_ROW_HEIGHT).flex_none().relative()
                    .child(div().absolute().left(5).top(GRAPH_ROW_HEIGHT / 2 - 3).size(6).rounded_full().border_1().border_color(t.muted)))
                  .child(div().flex_1().min_w(0).truncate().child(`Uncommitted changes (${this.files.length})`))
                  .child(div().w(32).flex_none().text_right().child("*"))
                  .child(div().w(100).flex_none().child("*"))
                  .child(div().w(66).flex_none().text_size(10).child("*"))))
                .children(rows.map(row => this.graphRow(row, width, t)))
                .when(!rows.length, el => el.child(div().p(14).text_color(t.muted).child(empty))))
              .child(Scrollbar.vertical(`${id}-list`).absolute().inset_0()))))
        .child(Scrollbar.horizontal(`${id}-x`).absolute().inset_0()))
      .when(Boolean(this.selectedCommit), el => el.child(this.commitView(t)))
      .when(Boolean(error) && rows.length > 0, el => el.child(div().px(12).py(6).text_color(t.ansi1).child(error)))
      .child(div().px(12).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(count >= GRAPH_LIMIT ? `Latest ${GRAPH_LIMIT} commits · ${scope}` : `${count} commits · ${scope}`));
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
    if (!commit) this.open = file.path;
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
    const current = key() === this.context;
    if (!current) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const selectedCount = this.files.filter(f => f.staged).length;
    const hasMessage = Boolean(this.files.length && this.message.trim() && this.root && current);
    const enabled = hasMessage && !this.busy && !this.loading;
    const checkboxDisabled = this.busy || this.loading || !this.files.length || !current;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.view !== "changes" && this.selectedCommit) { this.closeDetail(cx); cx.stop_propagation(); }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(Tabs.new("git-views").h_flex().flex_none().h(30).p(2).gap(2).rounded(6).bg(t.raised)
          .children(["changes", "history", "graph"].map(view => div().w(28).h(26).flex_none().tooltip(view === "changes" ? "Changes" : view === "history" ? "History" : "Git Graph").child(Tab.new(`git-view-${view}`).w(28).h(26).items_center().justify_center().rounded(4)
            .selected(this.view === view)
            .accessibility_label(view === "changes" ? "Changes" : view === "history" ? "History" : "Git Graph")
            .bg(this.view === view ? t.selected : t.raised).text_color(this.view === view ? t.foreground : t.muted)
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.selectView(view, cx))
            .child(svg(`mods/changes-graph/${view}.svg`).size(15))))))
        .child(div().font_semibold().child(this.view === "changes" ? "Changes" : this.view === "history" ? "History" : "Git Graph"))
        .when(this.view === "history" && Boolean(this.historyPath), el => el
          .child(div().flex_1().min_w(0).truncate().tooltip(this.historyPath).text_size(11).text_color(t.muted).child(this.historyPath))
          .child(Button.new("clear-file-history").size(24).flex_none().flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted)
            .accessibility_label("Show all history").tooltip("Show all history").hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { this.historyPath = null; this.history = []; this.selectView("history", cx); }).child(svg("mods/pane/close.svg").size(12))))
        .when(this.view === "changes", el => el
          .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
            .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))))
        .child(div().flex_1())
        .when(this.view === "changes", el => el.child(this.fileActions.header(t, cx))))
      .when(this.view !== "changes", el => el.child(this.graphView(t, this.view === "history")))
      .when(this.view === "changes", panel => panel
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.slice(0, 1000).map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        const snapshot = this.fileActions.snapshot();
        const row = h_flex().id(`change-${f.path}:${f.fresh ? "untracked" : "tracked"}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openFile(f, null, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().text_color(f.status === "D" ? t.muted : t.foreground).when(f.status === "D", el => el.line_through()).child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
          .child(this.fileCheckbox(`select-file-${f.path}:${f.fresh ? "untracked" : "tracked"}`, f.staged, `${f.staged && f.unstaged ? "Partially staged" : f.staged ? "Staged" : "Stage"} ${f.path}`, (checked, cx) => this.fileActions.stageFiles([f.path], checked, cx, snapshot), t, f.staged && f.unstaged, checkboxDisabled));
        return this.fileActions.row(f, row, t, cx);
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(this.gitToolbar.render(t, cx))
      .child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.canvas)
        .child(div().id("commit-message").w_full().min_w(0).px(4).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.input).w_full().h(54).text_size(12).line_height("18px").text_color(t.foreground).accessibility_label("Commit message")))
        .child(h_flex().w_full().items_center().justify_end().gap(8)
          .child(Button.new("commit").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.raised).text_color(hasMessage ? t.foreground : t.dim).text_size(12).font_normal().disabled(!enabled).accessibility_label(selectedCount ? "Commit selected files" : "Commit all changes").tooltip(selectedCount ? "Commit selected files" : "Commit all changes").hover(s => s.bg(t.hover)).focus(s => s.border_color(t.accent)).on_click((_e, cx) => this.commit(cx)).child(this.committing ? "Committing…" : "Commit"))
          .child(this.generator.render(t, cx)))));
  }
}
