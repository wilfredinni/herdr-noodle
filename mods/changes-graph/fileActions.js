import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Popover } from "gpui-base";
import { git, verify, stage, stashes, popStash, trash, addIgnore } from "./fileOps.js";
import { showGitError } from "./gitError.js";
import { shortAge } from "./graph.js";

export class FileActions {
  constructor(owner, key, cx) {
    this.owner = owner; this.key = key; this.focus = cx.focus_handle(); this.reset();
  }

  reset() {
    this.openKind = null; this.target = null; this.mode = "actions"; this.confirmation = null;
    this.stashes = []; this.patch = null; this.error = null; this.loading = false;
    this.sequence = (this.sequence ?? 0) + 1;
  }

  snapshot() { const p = this.owner; return { ...p.gitToolbar.snapshot(), head: p.head, hasHead: p.hasHead }; }
  current(s) { return this.owner.gitToolbar.current(s); }
  enabled() { return this.owner.gitToolbar.enabled(); }

  show(kind, path, open, cx) {
    this.reset();
    if (!open || !this.enabled()) { cx.notify(); return; }
    this.openKind = kind; this.target = path; this.menuContext = this.snapshot();
    if (kind === "all") this.loadStashes(cx);
    cx.notify();
  }

  loadStashes(cx) {
    const s = this.menuContext, sequence = this.sequence;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const entries = await stashes(s);
        if (sequence === this.sequence && this.current(s)) this.stashes = entries;
      } catch (e) { if (sequence === this.sequence && this.current(s)) this.error = e.message; }
      finally { if (sequence === this.sequence) this.loading = false; cx.notify(); }
    });
  }

  run(label, task, cx, snapshot = this.snapshot()) {
    if (!this.enabled() || !this.current(snapshot)) return;
    const p = this.owner, s = snapshot;
    this.openKind = null; this.sequence++; p.busy = true; p.note = null;
    cx.spawn(async cx => {
      try {
        await verify(s);
        if (!this.current(s)) throw new Error("Repository changed. Review the changes and try again.");
        await task(s);
      } catch (e) { if (this.current(s)) showGitError(label, e, s); }
      finally { p.busy = false; p.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  stageFiles(paths, checked, cx, snapshot = this.snapshot()) {
    this.run(checked ? "Stage files" : "Unstage files", s => stage(paths, checked, s), cx, snapshot);
  }

  confirm(title, message, action, label, cx) {
    this.confirmation = { title, message, action, label, snapshot: this.menuContext };
    this.mode = "confirm"; cx.notify();
  }

  option(id, label, action, disabled = false, danger = false) {
    const snapshot = this.menuContext;
    return this.owner.gitToolbar.option(`files-${id}`, label, cx => { if (this.current(snapshot) && this.enabled()) action(cx); }, disabled)
      .when(danger && !disabled, el => el.text_color(this.colors.ansi1));
  }

  group(items) { return v_flex().gap(1).children(items); }
  divider() { return div().h(1).mx(5).my(4).bg(this.colors.border); }

  confirmationBody() {
    const c = this.confirmation, t = this.colors;
    return v_flex().p(6).gap(9).text_color(t.foreground)
      .child(div().text_size(13).font_semibold().child(c.title))
      .child(div().text_size(12).line_height("18px").text_color(t.muted).child(c.message))
      .child(h_flex().gap(6).justify_end()
        .child(this.option("cancel", "Cancel", cx => { this.mode = "actions"; cx.notify(); }))
        .child(this.option("confirm", c.label, cx => this.run(c.label, c.action, cx, c.snapshot), false, true)));
  }

  allBody(cx) {
    const p = this.owner, t = this.colors;
    if (this.mode === "confirm") return this.confirmationBody();
    if (this.mode === "stashes" || this.mode === "patch") return this.stashBody(cx);
    const staged = p.files.some(f => f.staged), unstaged = p.files.some(f => f.unstaged), fresh = p.files.some(f => f.fresh);
    const conflict = p.files.some(f => f.status === "U");
    return this.group([
      this.option("stage-all", "Stage All", cx => this.stageFiles(null, true, cx, this.menuContext), !unstaged),
      this.option("unstage-all", "Unstage All", cx => this.stageFiles(null, false, cx, this.menuContext), !staged),
      this.option("restore-all", "Restore All Changes…", cx => this.confirm("Restore all changes?", "Reset tracked files and the index to HEAD. Newly added and untracked files will move to Trash.", async s => {
        await trash(null, s, true);
        await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], s);
      }, "Restore", cx), !p.hasHead || !p.files.length || conflict, true),
      this.divider(),
      this.option("stash-all", "Stash All", cx => this.run("Stash", s => git(["stash", "push", "--include-untracked", "-m", "Herdr stash"], s), cx, this.menuContext), !p.hasHead || !p.files.length || conflict),
      this.option("stash-pop", "Stash Pop…", cx => {
        const entry = this.stashes[0];
        if (!entry) return;
        this.confirm("Apply the latest stash?", `${entry.ref}: ${entry.subject}. Its staged state will be restored; conflicts may need resolving.`, s => popStash(entry.hash, s), "Apply stash", cx);
      }, this.loading || !this.stashes.length || conflict),
      this.option("view-stash", "View Stash", cx => { this.mode = "stashes"; cx.notify(); }, this.loading || !this.stashes.length),
      ...(this.error ? [div().px(8).py(4).text_size(11).text_color(t.muted).child(this.error)] : []),
      this.divider(),
      this.option("discard-tracked", "Discard Tracked Changes…", cx => this.confirm("Discard unstaged changes?", "Restore tracked working files from the index. Staged changes and untracked files stay as they are.", s => git(["restore", "--worktree", "--", "."], s), "Discard", cx), !p.files.some(f => f.unstaged && !f.fresh) || conflict, true),
      this.option("trash-untracked", "Trash Untracked Files…", cx => this.confirm("Trash untracked files?", "Move untracked files to your system Trash. Tracked and staged files stay as they are.", s => trash(null, s), "Move to Trash", cx), !fresh, true),
    ]);
  }

  stashBody(cx) {
    const t = this.colors;
    if (this.mode === "patch") return v_flex().gap(5)
      .child(this.option("stash-back", "Back to stashes", cx => { this.mode = "stashes"; this.error = null; cx.notify(); }))
      .child(div().h(270).overflow_y_scroll().overflow_x_scroll().p(8).font_family("JetBrains Mono").text_size(11).line_height("17px").text_color(t.muted).child(this.error || this.patch || "Loading stash…"));
    return v_flex().gap(3)
      .child(this.option("stash-menu-back", "Back", cx => { this.mode = "actions"; cx.notify(); }))
      .child(div().px(8).text_size(11).text_color(t.muted).child("Stashes"))
      .child(v_flex().h(Math.min(270, this.stashes.length * 45)).overflow_y_scroll().children(this.stashes.map(entry =>
        Button.new(`stash-${entry.hash}`).h_flex().h(45).px(8).items_center().justify_start().font_normal().rounded(4).bg(t.popover).hover(s => s.bg(t.hover))
          .accessibility_label(`View ${entry.ref}`).on_click((_e, cx) => this.showStash(entry, cx))
          .child(v_flex().min_w(0).gap(2)
            .child(div().truncate().text_size(12).text_color(t.foreground).child(entry.subject))
            .child(div().text_size(10.5).text_color(t.muted).child(`${entry.ref} · ${shortAge(entry.time)}`))))));
  }

  showStash(entry, cx) {
    if (!/^[0-9a-f]{40,64}$/.test(entry.hash) || !this.current(this.menuContext)) return;
    const s = this.menuContext, sequence = this.sequence;
    this.mode = "patch"; this.patch = null; this.error = null;
    cx.spawn(async cx => {
      try {
        const output = await git(["stash", "show", "--patch", "--include-untracked", "--no-ext-diff", "--no-textconv", entry.hash], s);
        if (sequence === this.sequence && this.current(s)) this.patch = output ? output.slice(0, 200000) + (output.length > 200000 ? "\nStash preview limited to 200,000 characters." : "") : "This stash has no text diff.";
      } catch (e) { if (sequence === this.sequence && this.current(s)) this.error = e.message; }
      cx.notify();
    });
    cx.notify();
  }

  fileBody(file, cx) {
    if (this.mode === "confirm") return this.confirmationBody();
    const p = this.owner, s = this.menuContext, canIgnore = file.fresh && !/[\r\n]/.test(file.path);
    const open = (kind, diffMode) => cx => { if (!this.current(s)) return; this.openKind = null; p.openFile(file, null, cx, { kind, diffMode }); cx.notify(); };
    const copy = relative => cx => { if (!this.current(s)) return; cx.write_to_clipboard(relative ? file.path : `${s.root.replace(/[\\/]$/, "")}/${file.path}`); this.openKind = null; cx.notify(); };
    return this.group([
      this.option("stage-file", "Stage File", cx => this.stageFiles([file.path], true, cx, s), !file.unstaged),
      this.option("discard-file", file.fresh ? "Move to Trash…" : "Discard Changes…", cx => file.fresh
        ? this.confirm("Move this file to Trash?", file.path, s => trash([file.path], s), "Move to Trash", cx)
        : this.confirm("Discard unstaged changes?", `${file.path}: restore this file from the index. Staged changes stay intact.`, s => git(["restore", "--worktree", "--", file.path], s), "Discard", cx), !file.unstaged || file.status === "U", true),
      this.divider(),
      this.option("unstage-file", "Unstage Changes", cx => this.stageFiles([file.path], false, cx, s), !file.staged),
      this.option("staged-diff", "Staged Changes", open("diff", "staged"), !file.staged),
      this.divider(),
      this.option("copy-path", "Copy Path", copy(false)),
      this.option("copy-relative", "Copy Relative Path", copy(true)),
      this.divider(),
      this.option("ignore", "Add to .gitignore", cx => this.run("Ignore file", s => addIgnore(file.path, false, s), cx, s), !canIgnore),
      this.option("exclude", "Add to .git/info/exclude", cx => this.run("Exclude file", s => addIgnore(file.path, true, s), cx, s), !canIgnore),
      this.divider(),
      this.option("open-diff", "Open Diff", open("diff", "unstaged"), !file.unstaged),
      this.option("open-file-diff", "Open File Diff", open("diff", "all")),
      this.option("view-file", "View File", open("file", "all")),
      this.divider(),
      this.option("history", "View File History", cx => { this.openKind = null; p.showFileHistory(file.path, cx); }, file.fresh || !p.hasHead),
    ]);
  }

  frame(body) {
    const t = this.colors, width = this.mode === "patch" ? 520 : this.mode === "confirm" ? 300 : 240;
    return v_flex().w(width).p(5).gap(1).bg(t.popover).border_1().border_color(t.border).rounded(8).shadow_md().track_focus(this.focus)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.reset(); cx.stop_propagation(); cx.notify(); } }).child(body);
  }

  header(t, cx) {
    this.colors = t; this.owner.gitToolbar.colors = t;
    const enabled = this.enabled(), files = this.owner.files, snapshot = this.snapshot();
    const unstaged = files.some(file => file.unstaged ?? !file.staged), label = "Stage all";
    const control = Button.new("stage-all-toggle").h_flex().h(28).px(6).items_center().rounded(6).bg("#00000000").border_1().border_color("#00000000")
      .font_normal().text_size(11).text_color(enabled && unstaged ? t.muted : t.dim).disabled(!enabled || !unstaged).accessibility_label(label)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent)).on_click((_e, cx) => this.stageFiles(null, true, cx, snapshot)).child(label);
    const dropdown = Button.new("file-actions-menu").w(20).h(28).flex().items_center().justify_center().rounded(6).bg("#00000000").border_1().border_color("#00000000")
      .disabled(!enabled).text_color(t.dim).accessibility_label("Change actions").hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent))
      .child(svg("mods/changes-graph/chevron.svg").size(11));
    return h_flex().flex_none().items_center().child(control)
      .child(Popover.new("change-actions").open(this.openKind === "all").anchor("top_right").track_focus(this.focus)
        .on_open_change((open, cx) => this.show("all", null, open, cx)).trigger(dropdown)
        .when(this.openKind === "all", el => el.content(this.frame(this.allBody(cx)))));
  }

  rowMenu(file, mode, t, cx, disabled) {
    this.colors = t; this.owner.gitToolbar.colors = t;
    const target = `${mode}-${file.path}:${file.fresh ? "untracked" : "tracked"}`, open = this.openKind === "file-menu" && this.target === target;
    return div().flex_none().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
      .child(Popover.new(`file-menu-${target}`).open(open).anchor("top_right").track_focus(this.focus)
        .on_open_change((open, cx) => this.show("file-menu", target, open, cx))
        .trigger(Button.new(`file-more-${target}`).size(22).flex().items_center().justify_center().rounded(4).bg("#00000000").text_color(t.muted).disabled(disabled)
          .accessibility_label(`Actions for ${file.path}`).tooltip(`Actions for ${file.path}`).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
          .child(svg("mods/changes-graph/more.svg").size(13)))
        .when(open, el => el.content(this.frame(this.fileBody(file, cx)))));
  }

  row(file, row, t, cx, mode = "all") {
    this.colors = t; this.owner.gitToolbar.colors = t;
    const target = `${mode}-${file.path}:${file.fresh ? "untracked" : "tracked"}`, open = this.openKind === "file" && this.target === target;
    return Popover.new(`file-context-${target}`).mouse_button("right").open(open).anchor("top_right").track_focus(this.focus)
      .on_open_change((open, cx) => this.show("file", target, open, cx)).trigger(row)
      .when(open, el => el.content(this.frame(this.fileBody(file, cx))));
  }
}
