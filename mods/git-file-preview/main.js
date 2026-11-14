import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Button, Scrollbar, v_virtual_list, TextView, Popover, VirtualListScrollHandle } from "gpui-base";
import { shared, exec, readTextFile, watchFolder, theme, settings, props, focused, panes, setShared, run, appHome } from "herdr";
import { Review } from "./review.js";
import { Documents } from "./documents.js";
import { readDiff, readFile, readMarkdown, isMarkdown, splitRows, git } from "./content.js";

export default class FilePreview extends View {
  init(_props, cx) {
    this.selectionKey = props()?.selectionKey || _props?.selectionKey || "git-file-preview.unselected"; this.rows = []; this.mode = "diff"; this.version = 0;
    this.layout = "unified";
    if (typeof Documents !== "undefined") { this.documents = new Documents(this, cx); this.review = new Review(this); this.scroll = VirtualListScrollHandle.new(); }
    this.refresh(cx);
    cx.timer.every(10000, cx => {
      if (this.selection && !this.selection.hash) {
        this.dirty = true;
        if (this.active()) this.refresh(cx, true);
      }
    });
  }

  active() {
    const tab = panes().find(pane => pane.pane === this.selection?.sourcePane)?.tab;
    return !tab || focused()?.tab === tab;
  }

  affected(paths) {
    const normalize = path => path.replaceAll("\\", "/").replace(/\/+$/, "");
    const root = normalize(this.selection.root), file = `${root}/${normalize(this.selection.file.path)}`;
    return paths.some(path => {
      path = normalize(path);
      return path === root || path === file || file.startsWith(path + "/") || path === `${root}/.git` || path.startsWith(`${root}/.git/`);
    });
  }

  watch(root, on, cx) {
    if (on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async cx => {
      try {
        while (this.watched === root) {
          const paths = await watchFolder(root);
          if (this.watched === root && !this.selection?.hash && this.affected(paths)) {
            this.dirty = true;
            if (this.active()) this.refresh(cx, true);
          }
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }

  refresh(cx, force = false) {
    const selection = shared(this.selectionKey), context = JSON.stringify(selection);
    if (!selection || (!force && context === this.context) || (context === this.context && this.loading)) return;
    if (context !== this.context) {
      const previous = this.selection;
      const sameFile = previous && previous.root === selection.root && previous.on === selection.on && previous.file?.path === selection.file?.path && previous.hash === selection.hash && previous.kind === selection.kind && previous.diffMode === selection.diffMode;
      if (!sameFile) this.mode = /\.(png|jpe?g|svg)$/i.test(selection.file?.path || "") && !selection.on && !selection.hash ? "asset" : selection.kind === "file" ? "source" : "diff";
      this.asset = null; this.source = null; this.sourceWidth = null; this.sourceError = null; this.sourceLoading = false; this.menuOpen = false; this.menuConfirmation = null; this.conflict = null; this.liveFile = null;
      this.rows = []; this.result = null; this.markdown = null; this.markdownError = null;
    }
    let changed = Boolean(this.error);
    this.dirty = false;
    this.context = context; this.selection = selection;
    this.root = selection.root; this.on = selection.on; this.head = selection.head; this.branch = selection.branch; this.hasHead = selection.hasHead;
    this.error = null; this.loading = true; this.markdownLoading = false;
    const version = ++this.version;
    cx.spawn(async cx => {
      try {
        if (!selection.file) { this.rows = []; this.loading = false; changed = true; return; }
        if (!selection.hash && selection.head != null) {
          const status = await git(selection, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", selection.file.path], { exec });
          if (version !== this.version) return;
          const entry = status.split("\0").find(entry => entry.slice(3) === selection.file.path);
          const x = entry?.[0] || " ", y = entry?.[1] || " ";
          const before = JSON.stringify(this.liveFile);
          this.liveFile = { ...selection.file, indexStatus: x, staged: ![" ", "?"].includes(x), unstaged: y !== " ", fresh: x === "?", status: entry ? /U/.test(x + y) || ["AA", "DD"].includes(x + y) ? "U" : (y === " " ? x : y) : selection.file.status };
          changed ||= before !== JSON.stringify(this.liveFile);
        }
        if (/\.(png|jpe?g|svg)$/i.test(selection.file.path) && !selection.on && !selection.hash && this.mode !== "source" && this.mode !== "diff") { await this.loadAsset(cx); changed = true; return; }
        const result = await (selection.kind === "file" ? readFile : readDiff)(selection, { exec, readTextFile }, this.result);
        if (version !== this.version) return;
        if (result === this.result) {
          if (this.mode === "markdown") await this.loadMarkdown(cx);
          if (this.mode === "source" && selection.kind !== "file") await this.loadSource(cx);
          return;
        }
        this.result = result; changed = true;
        this.rows = result.rows;
        if (selection.navigation?.line && this.scroll) this.scroll.scroll_to_item(Math.max(0, this.rows.findIndex(r => r.newNumber === selection.navigation.line || r.number === selection.navigation.line)), "center");
        this.split = splitRows(result.rows); this.truncated = result.truncated; this.syntaxError = result.syntaxError;
        this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 72));
        this.watch(selection.root, selection.on, cx);
        if (this.mode === "markdown") await this.loadMarkdown(cx);
        else this.markdown = null;
        if (this.mode === "source" && selection.kind !== "file") await this.loadSource(cx);
      } catch (error) { if (version === this.version) { this.error = String(error); changed = true; } }
      finally {
        if (version === this.version) {
          this.loading = false;
          if (changed) cx.notify();
          if (this.dirty && this.active()) this.refresh(cx, true);
        }
      }
    });
  }

  async loadMarkdown(cx) {
    const version = this.version;
    let changed = Boolean(this.markdownError);
    this.markdownError = null; this.markdownLoading = true;
    try {
      const result = await readMarkdown(this.selection, { exec, readTextFile });
      if (version === this.version && (this.markdown?.text !== result.text || this.markdown?.truncated !== result.truncated || this.markdown?.deleted !== result.deleted)) {
        this.markdown = result; this.markdownVersion = (this.markdownVersion ?? 0) + 1; changed = true;
      }
    } catch (error) { if (version === this.version) { this.markdown = null; this.markdownError = String(error); changed = true; } }
    finally { if (version === this.version) { this.markdownLoading = false; if (changed) cx.notify(); } }
  }

  async loadSource(cx) {
    const version = this.version;
    let changed = Boolean(this.sourceError);
    this.sourceLoading = true; this.sourceError = null;
    try {
      const result = await readFile(this.selection, { exec, readTextFile }, this.source);
      if (version === this.version && result !== this.source) { changed = true; this.source = result; this.sourceWidth = Math.max(300, ...result.rows.map(row => row.text.length * 7 + 72)); }
    } catch (error) { if (version === this.version) { changed = true; this.source = null; this.sourceError = String(error); } }
    finally { if (version === this.version) { this.sourceLoading = false; if (changed) cx.notify(); } }
  }

  async close() { this.watched = null; await this.documents?.close(); }

  async loadAsset(cx) {
    const version = this.version;
    const r = await exec("python3", [`${appHome()}/helpers/noodle/workspace.py`, "asset_preview", JSON.stringify({ home: appHome(), root: this.root, path: this.selection.file.path })]);
    const result = JSON.parse(r.stdout || "{}"); if (r.code || result.error) throw new Error(result.error || r.stderr);
    if (version === this.version) { this.asset = result; this.mode = "asset"; cx.notify(); }
  }

  closePreview() {
    const tab = focused()?.tab, pane = panes().find(p => p.tab === tab && p.mod === "git-file-preview");
    if (pane) run("pane.close", { pane: pane.pane });
  }

  openFile(file, _commit, cx, options = {}) {
    setShared(this.selectionKey, { ...this.selection, file, ...options }); this.refresh(cx); cx.notify();
  }

  showFileHistory(path, cx) {
    setShared(`${this.selectionKey}.history`, { root: this.root, on: this.on, path, sequence: Date.now() }); cx.notify();
  }

  dispatch(action, cx, extra = {}) {
    if (this.pending || this.selection.hash || this.selection.head == null) return;
    this.pending = `${Date.now()}-${this.actionSequence = (this.actionSequence || 0) + 1}`;
    this.menuOpen = false; this.menuConfirmation = null; this.actionError = null;
    setShared(`${this.selectionKey}.action`, { id: this.pending, action, selection: this.selection, ...extra }); cx.notify();
  }

  selectMode(mode, cx) {
    if (mode === "diff" && this.selection.kind === "file" && this.selection.gitRoot !== null) {
      this.openFile(this.selection.file, null, cx, { kind: "diff" }); return;
    }
    this.mode = mode;
    if (mode === "asset") cx.spawn(async cx => { try { await this.loadAsset(cx); } catch (e) { this.error = e.message; cx.notify(); } });
    if (mode === "source" && this.selection.kind !== "file" && !this.source && !this.sourceLoading) cx.spawn(cx => this.loadSource(cx));
    if (mode === "markdown" && !this.markdown && !this.markdownLoading) cx.spawn(cx => this.loadMarkdown(cx));
    cx.notify();
  }

  reviewConflict(cx) {
    const context = this.context, selection = this.selection;
    this.conflict = { loading: true }; this.selectMode("source", cx);
    cx.spawn(async cx => {
      try {
        const script = await readTextFile(`${appHome()}/mods/git-file-preview/conflict.py`);
        if (!script) throw new Error("Conflict helper is unavailable");
        const result = await exec("python3", ["-c", script, selection.root, selection.file.path, "inspect"], { cwd: selection.root, on: selection.on });
        if (result.code !== 0) throw new Error(result.stderr || "Cannot review this conflict");
        if (context === this.context) this.conflict = { ...JSON.parse(result.stdout) };
      } catch (error) { if (context === this.context) this.conflict = { error: String(error.message || error) }; }
      cx.notify();
    });
  }

  resolveConflict(choice, cx) {
    const review = this.conflict;
    if (!review?.signature) return;
    this.conflict = null;
    this.dispatch("resolve", cx, { choice, signature: review.signature });
  }

  conflictBanner(t, cx) {
    const review = this.conflict;
    const button = (id, label, action, disabled = false) => Button.new(id).h(28).px(9).flex_none().rounded(4).border_1().border_color(t.border).bg(t.raised).text_color(t.foreground).text_size(11).font_normal()
      .disabled(disabled || Boolean(this.pending)).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => action(cx)).child(label);
    return v_flex().flex_none().px(16).py(10).gap(8).bg(t.ansi1 + "12").border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/changes-graph/warning.svg").size(14).text_color(t.ansi1))
        .child(div().flex_1().text_size(12).text_color(t.foreground).child(review?.error || (review?.loading ? "Reading conflict…" : review?.signature ? `${review.count} conflict ${review.count === 1 ? "block" : "blocks"} · choose a resolution, then confirm` : "Merge conflict · review before committing")))
        .child(button("review-conflict", "Review conflict", cx => this.reviewConflict(cx), review?.loading)))
      .when(Boolean(review?.signature), el => el
        .child(h_flex().gap(6).overflow_x_scrollbar()
          .children((review.count ? [["ours", "Keep current"], ["theirs", "Keep incoming"], ["both", "Keep both"]] : [["resolved", "Mark resolved"]]).map(([choice, label]) =>
            button(`resolve-${choice}`, label, cx => { review.choice = choice; cx.notify(); })))
          .child(button("cancel-resolution", "Cancel", cx => { this.conflict = null; cx.notify(); })))
        .when(Boolean(review.choice), el => el
          .child(div().text_size(12).text_color(t.muted).child(`${({ ours: "Keep current", theirs: "Keep incoming", both: "Keep both", resolved: "Keep the manually resolved file" })[review.choice]} for this file. This writes the resolution and stages the file.`))
          .child(button("confirm-resolution", "Resolve and stage", cx => this.resolveConflict(review.choice, cx)))));
  }

  number(value, t) {
    return div().w(40).flex_none().pr(10).text_right().text_color(t.dim).child(value == null ? "" : String(value));
  }

  code(row, t) {
    return h_flex().flex_1().min_w(0).font_normal().children((row?.spans || [{ text: row?.text || " ", color: null }]).map(span =>
      div().flex_none().text_color(typeof span.color === "number" ? t[`ansi${span.color}`] : span.color || t.foreground).child(span.text)));
  }

  diffRow(row, t, source = false) {
    const { kind, number, text, change, deletedBefore, deletedAfter } = row;
    if (kind === "@") return div().w_full().px(16).h(24).flex_none().truncate().bg(t.ansi4 + "12").text_color(t.ansi4).child(text);
    return h_flex().w_full().h(24).flex_none()
      .when(kind === "+", el => el.bg(t.ansi2 + "18")).when(kind === "-", el => el.bg(t.ansi1 + "18"))
      .when(!source, el => el.child(this.number(row.oldNumber, t)))
      .child(this.number(source ? number : row.newNumber, t))
      .when(source, el => el.child(div().w(8).h(24).flex_none().relative()
        .when(Boolean(change), e => e.child(div().absolute().left(1).top(4).w(3).h(16).bg(change === "added" ? t.ansi2 : t.ansi3)))
        .when(Boolean(deletedBefore), e => e.child(svg("mods/git-file-preview/deleted.svg").w(6).h(5).absolute().left(0).top(0).text_color(t.ansi1)))
        .when(Boolean(deletedAfter), e => e.child(svg("mods/git-file-preview/deleted.svg").w(6).h(5).absolute().left(0).bottom(0).text_color(t.ansi1)))))
      .when(!source, el => el.child(div().w(22).flex_none().text_center().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : "")))
      .child(this.code(row, t));
  }

  splitRow(pair, t) {
    const half = (row, before) => h_flex().flex_1().min_w(0).h(24).overflow_hidden().tooltip(row?.text || "")
      .when(before, el => el.border_r(1).border_color(t.border))
      .when(row?.kind === "@", el => el.bg(t.ansi4 + "12"))
      .when(row?.kind === "+", el => el.bg(t.ansi2 + "18")).when(row?.kind === "-", el => el.bg(t.ansi1 + "18"))
      .child(this.number(before ? row?.oldNumber : row?.newNumber, t))
      .child(div().w(18).flex_none().text_center().text_color(row?.kind === "+" ? t.ansi2 : row?.kind === "-" ? t.ansi1 : t.dim).child(["+", "-"].includes(row?.kind) ? row.kind : ""))
      .child(this.code(row, t));
    return h_flex().w_full().h(24).child(half(pair.before, true)).child(half(pair.after, false));
  }

  iconButton(id, label, icon, action, t) {
    return Button.new(id).size(26).flex().items_center().justify_center().flex_none().rounded(4).bg("#00000000").text_color(t.muted)
      .accessibility_label(label).tooltip(label).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => action(cx)).child(svg(icon).size(14));
  }

  segments(id, choices, selected, action, t) {
    return h_flex().flex_none().gap(2).p(2).rounded(5).border_1().border_color(t.border).bg(t.background)
      .children(choices.map(([value, label]) => Button.new(`${id}-${value}`).h(24).px(8).flex().items_center().rounded(3).text_size(11).font_normal()
        .bg(selected === value ? t.selected : "#00000000").text_color(selected === value ? t.foreground : t.muted).accessibility_label(label)
        .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => action(value, cx)).child(label)));
  }

  commitCard(t, cx) {
    const commit = this.selection.commit;
    const totals = commit.files.reduce((n, f) => ({ add: n.add + (f.add || 0), del: n.del + (f.del || 0) }), { add: 0, del: 0 });
    const [subject, ...body] = commit.message.split("\n");
    return v_flex().id("preview-commit").h(Math.min(230, 164 + (body.join("").trim() ? 10 + body.filter(Boolean).length * 18 : 0))).flex_none().overflow_y_scrollbar().px(20).py(16).gap(10).bg(t.background).border_b(1).border_color(t.border)
      .child(div().text_size(15).font_semibold().child(subject))
      .when(Boolean(body.join("").trim()), el => el.child(div().text_size(12).text_color(t.muted).child(body.join("\n").trim())))
      .child(h_flex().gap(8).items_center()
        .child(div().size(24).flex_none().flex().items_center().justify_center().rounded(12).bg(t.selected).text_size(11).text_color(t.accent).child(commit.author.split(/\s+/).map(p => p[0]).slice(0, 2).join("")))
        .child(div().text_size(12).font_semibold().tooltip(commit.email).child(commit.author))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(commit.date).child(commit.age ? `committed ${commit.age} ago` : commit.date.replace("T", " "))))
      .child(h_flex().gap(12).text_size(11).text_color(t.muted).items_center()
        .child(Button.new("copy-commit-hash").h(24).px(4).bg("#00000000").text_color(t.muted).text_size(11).font_normal().tooltip("Copy commit hash")
          .on_click((_e, cx) => cx.write_to_clipboard(commit.hash)).child(`Commit ${commit.hash.slice(0, 8)}`))
        .child(div().truncate().tooltip(commit.parents.join("\n") || "Root commit").child(commit.parents.length ? `Parent ${commit.parents[0].slice(0, 8)}${commit.parents.length > 1 ? " · first parent" : ""}` : "Root commit"))
        .child(div().text_color(t.ansi2).child(`+${commit.add ?? totals.add}`)).child(div().text_color(t.ansi1).child(`−${commit.del ?? totals.del}`)))
      .child(h_flex().h(34).flex_none().overflow_x_scrollbar().gap(6).items_center().children(commit.files.map(file =>
        Button.new(`preview-commit-file-${file.path}`).h_flex().h(28).px(8).gap(5).flex_none().items_center().rounded(4).border_1().border_color(t.border)
          .bg(file.path === this.selection.file?.path ? t.selected : "#00000000").text_size(11).font_normal().text_color(file.path === this.selection.file?.path ? t.foreground : t.muted)
          .accessibility_label(`Preview commit file ${file.path}`).tooltip(file.path).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
          .on_click((_e, cx) => this.openFile(file, commit, cx, { kind: "diff" })).child(svg("mods/changes-graph/file.svg").size(12)).child(file.path.split("/").pop()))))
      .when(commit.fileCount > commit.files.length, el => el.child(div().text_size(11).text_color(t.muted).child(`Showing the first ${commit.files.length} of ${commit.fileCount} files`)));
  }

  fileMenu(t, cx) {
    const s = this.selection, file = this.liveFile || s.file;
    const mutable = !s.hash && s.head != null;
    const option = (id, label, action, disabled = false, danger = false) => Button.new(`preview-${id}`).h(30).w_full().px(10).flex().items_center().justify_start().rounded(4).bg(t.popover).text_size(12).font_normal().text_color(disabled || this.pending ? t.dim : danger ? t.ansi1 : t.foreground)
      .disabled(disabled || Boolean(this.pending)).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => { action(cx); cx.notify(); }).child(label);
    const close = action => cx => { this.menuOpen = false; action(cx); };
    const divider = () => div().h(1).my(4).bg(t.border);
    const confirm = (action, label, message) => cx => { this.menuConfirmation = { action, label, message }; cx.notify(); };
    const c = this.menuConfirmation;
    const body = c ? v_flex().gap(10).p(6)
      .child(div().text_size(13).font_semibold().child(c.label))
      .child(div().text_size(12).text_color(t.muted).child(`${file.path}: ${c.message}`))
      .child(h_flex().gap(8).justify_end()
        .child(option("cancel-action", "Cancel", cx => { this.menuConfirmation = null; cx.notify(); }))
        .child(option("confirm-action", c.label, cx => this.dispatch(c.action, cx), false, true)))
      : v_flex().gap(1)
        .when(mutable, el => el
          .child(option("stage", "Stage file", cx => this.dispatch("stage", cx), !file.unstaged || file.status === "U"))
          .child(option("unstage", "Unstage file", cx => this.dispatch("unstage", cx), !file.staged || file.status === "U"))
          .child(divider()))
        .child(option("menu-diff", "Open diff", close(cx => this.selectMode("diff", cx)), s.gitRoot === null))
        .child(option("menu-source", "View source", close(cx => this.selectMode("source", cx))))
        .child(option("menu-history", "View file history", close(cx => this.showFileHistory(file.path, cx)), Boolean(file.fresh) || s.gitRoot === null))
        .child(divider())
        .child(option("copy-relative", "Copy relative path", close(cx => cx.write_to_clipboard(file.path))))
        .child(option("copy-path", "Copy path", close(cx => cx.write_to_clipboard(`${this.root.replace(/[\\/]$/, "")}/${file.path}`))))
        .when(mutable, el => el.child(divider())
          .child(option("ignore", "Add to .gitignore", cx => this.dispatch("ignore", cx), !file.fresh))
          .child(option("exclude", "Add to .git/info/exclude", cx => this.dispatch("exclude", cx), !file.fresh))
          .child(divider())
          .child(option("discard", file.fresh ? "Move to Trash…" : "Discard changes…", file.fresh
            ? confirm("trash", "Move to Trash", "Move this untracked file to your system Trash.")
            : confirm("discard", "Discard changes", "Restore working content from the index. Staged changes stay intact."), !file.unstaged || file.status === "U", true)));
    return Popover.new("preview-file-menu").open(Boolean(this.menuOpen)).anchor("top_right")
      .on_open_change((open, cx) => { this.menuOpen = open; this.menuConfirmation = null; cx.notify(); })
      .trigger(this.iconButton("preview-more", "File preview actions", "mods/changes-graph/more.svg", () => {}, t))
      .content(v_flex().w(c ? 320 : 230).p(6).rounded(8).border_1().border_color(t.border).bg(t.popover).child(body));
  }

  render(cx) {
    if (JSON.stringify(shared(this.selectionKey)) !== this.context) this.refresh(cx);
    else if (this.dirty && this.active()) this.refresh(cx, true);
    const completed = shared(`${this.selectionKey}.result`);
    if (this.pending && completed?.id === this.pending) {
      this.pending = null; this.actionError = completed.error; this.refresh(cx, true);
    }
    const t = theme(), s = this.selection, file = s?.file;
    const sourceMode = this.mode === "source", source = s?.kind === "file" ? this.result : this.source;
    const rows = sourceMode ? source?.rows || [] : this.rows, split = !sourceMode && this.layout === "split";
    const error = sourceMode ? this.sourceError || (s?.kind === "file" ? this.error : null) : this.error;
    const result = sourceMode ? source : this.result;
    const scope = s?.hash ? s.hash.slice(0, 8) : s?.diffMode === "staged" ? "Staged changes" : s?.diffMode === "unstaged" ? "Working tree" : s?.kind === "file" ? "Source" : "Uncommitted changes";
    const name = s?.root?.split(/[\\/]/).filter(Boolean).pop() || "Repository";
    const status = this.liveFile?.status || (s?.diffMode === "staged" ? file?.indexStatus || file?.status : file?.status);
    const add = this.result?.stats?.add ?? file?.add ?? 0, del = this.result?.stats?.del ?? file?.del ?? 0;
    const extension = file?.path.split(".").pop().toLowerCase();
    const language = ({ js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript", py: "Python", md: "Markdown", json: "JSON", rs: "Rust", css: "CSS", html: "HTML", sh: "Shell", yml: "YAML", yaml: "YAML", toml: "TOML" })[extension] || "Plain text";
    return v_flex().id("file-preview").size_full().min_w(0).min_h(0).bg(t.canvas).text_color(t.foreground).text_size(12)
      .child(h_flex().h(58).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border).bg(t.background)
        .child(this.iconButton("close-preview", "Close preview", "mods/pane/close.svg", () => this.closePreview(), t))
        .child(svg("mods/changes-graph/file.svg").size(16).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().truncate().font_semibold().tooltip(file?.path || "").child(file?.path || (s?.commit ? "Commit details" : "File preview")))
          .child(div().truncate().text_size(11).text_color(t.muted).child(`${name}  ›  ${scope}`)))
        .when(Boolean(file), el => el
          .child(this.iconButton("preview-copy-path", "Copy file path", "mods/git-file-preview/copy.svg", cx => cx.write_to_clipboard(`${s.root.replace(/[\\/]$/, "")}/${file.path}`), t))
          .child(this.fileMenu(t, cx))
          .when(Boolean(this.documents && !s.on), el => el.child(Button.new("edit-working-file").h(28).px(8).rounded(5).text_size(12).child(s.hash || s.diffMode === "staged" ? "Edit working file" : "Edit").on_click((_e, cx) => this.documents.edit(cx))))))
      .when(Boolean(s?.commit), el => el.child(this.commitCard(t, cx)))
      .when(Boolean(file && status === "U" && !s.hash), el => el.child(this.conflictBanner(t, cx)))
      .when(Boolean(this.actionError), el => el.child(div().px(16).py(8).text_size(12).text_color(t.ansi1).child(this.actionError)))
      .when(Boolean(this.pending), el => el.child(div().px(16).py(8).text_size(11).text_color(t.muted).child("Applying Git action…")))
      .when(Boolean(file), el => el.child(h_flex().h(44).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar()
        .when(Boolean(this.review && !s.on), el => el.child(Button.new("open-review-tools").h(28).px(8).rounded(5).text_size(12).child("Review").on_click((_e, cx) => { this.mode = "review"; this.review.mode = "compare"; cx.notify(); })))
        .child(this.segments("file-mode", [...(s.gitRoot === null ? [] : [["diff", "Diff"]]), ["source", "Source"], ...(isMarkdown(file.path) ? [["markdown", "Preview"]] : []), ...(/\.(png|jpe?g|svg)$/i.test(file.path) && !s.on && !s.hash ? [["asset", "Image"]] : [])], this.mode, (mode, cx) => this.selectMode(mode, cx), t))
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().flex_1())
        .when(this.mode === "diff", el => el.child(this.segments("diff-layout", [["unified", "Unified"], ["split", "Split"]], this.layout, (layout, cx) => { this.layout = layout; cx.notify(); }, t)))))
      .when(this.mode === "asset", el => el.child(div().flex_1().min_h(0).id("asset-preview").overflow_scrollbar().p(20).child(this.asset ? image(this.asset.path).w(Math.min(720, this.asset.width)).h(Math.min(720, this.asset.width) * this.asset.height / this.asset.width) : div().text_color(t.muted).child(this.error || "Loading image…"))))
      .when(this.mode === "review", el => el.child(this.review.render(t, cx)))
      .when(this.mode === "edit", el => el.child(this.documents.render(t, cx)))
      .when(this.mode !== "markdown" && this.mode !== "edit" && this.mode !== "review" && this.mode !== "asset", el => el
        .when(split && Boolean(file), el => el.child(h_flex().h(28).flex_none().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
          .child(div().flex_1().px(14).border_r(1).border_color(t.border).child(s.hash ? "Parent · before" : s.diffMode === "staged" || s.diffMode === "all" ? "HEAD · before" : "Index · before"))
          .child(div().flex_1().px(14).child(s.hash ? "Commit · after" : s.diffMode === "staged" ? "Index · after" : "Working tree · after"))))
        .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).line_height("24px")
          .child(div().id("file-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(split ? 700 : sourceMode ? this.sourceWidth || this.diffWidth || 300 : (this.diffWidth || 300) + 50).h_full()
              .child(v_virtual_list("file-diff", split ? this.split?.length || 0 : rows.length, 24, i => String(i), range => split
                ? this.split.slice(range.start, range.end).map(pair => this.splitRow(pair, t))
                : rows.slice(range.start, range.end).map(row => this.diffRow(row, t, sourceMode))).size_full().when(Boolean(this.scroll), el => el.track_scroll(this.scroll)))))
          .child(Scrollbar.vertical("file-diff").viewport_from_layout().absolute().inset_0())
          .when(Boolean(error) || !file || (!rows.length && !split), el => el.child(div().absolute().top(20).px(20).text_color(error ? t.ansi1 : t.muted)
            .child(error || (!file ? s?.commit ? "This commit has no changed files." : "Select a file from Files, Changes, History or Graph" : this.loading || this.sourceLoading ? "Loading file…" : "This file is empty.")))))
        .when(Boolean(result?.deleted), el => el.child(div().px(16).py(8).text_size(11).text_color(t.muted).child("Deleted file · showing its previous version")))
        .when(Boolean(result?.syntaxError), el => el.child(div().px(16).py(8).text_size(11).text_color(t.muted).child(result.syntaxError)))
        .when(Boolean(result?.truncated), el => el.child(div().px(16).py(8).text_size(11).text_color(t.muted).child(sourceMode ? "Source preview limited to 5,000 lines or 400,000 characters" : "Showing the first 1,500 diff lines"))))
      .when(this.mode === "markdown", el => el
        .when(Boolean(this.markdown?.deleted), el => el.child(div().px(20).py(8).text_size(11).text_color(t.muted).border_b(1).border_color(t.border).child("Deleted file · showing its previous version")))
        .child(v_flex().id("markdown-document").flex_1().min_h(0).overflow_y_scrollbar().px(32).py(28).items_center()
          .when(!this.markdown, el => el.child(div().w_full().text_color(this.markdownError ? t.ansi1 : t.muted).child(this.markdownError || "Rendering Markdown…")))
          .when(Boolean(this.markdown), el => el.child(div().w_full().max_w(760).font_normal().text_size(14).line_height("24px").font_family(settings().ui_font ?? "Geist")
            .child(TextView.markdown(`markdown-${this.context}-${this.markdownVersion}`, this.markdown.text || "*This document is empty.*").selectable(true).scrollable(false).w_full().text_color(t.foreground)))))
        .when(this.markdown?.truncated, el => el.child(div().px(20).py(8).text_size(11).text_color(t.muted).child("Markdown preview limited to the first 200,000 characters"))))
      .when(Boolean(file), el => el.child(h_flex().h(28).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().child(language)).when(Boolean((this.mode === "markdown" ? this.markdown : result)?.lineEnding), el => el.child(div().child((this.mode === "markdown" ? this.markdown : result).lineEnding)))
        .child(div().flex_1()).child(div().child(this.mode === "edit" ? "Working file" : s.hash ? "Commit preview" : "Read-only preview"))));
  }
}
