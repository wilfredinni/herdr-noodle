import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Button, Popup } from "gpui-base";
import { appHome, exec, shared, setShared, panes, focused, run, closeOverlay, props, openOverlay, settings } from "herdr";

export async function workspaceCall(action, request) {
  const r = await exec("python3", [`${appHome()}/helpers/noodle/workspace.py`, action, JSON.stringify({ home: appHome(), ...request })]);
  let value; try { value = JSON.parse(r.stdout); } catch { throw new Error(r.stderr || "The workspace helper is unavailable"); }
  if (r.code || value.error) throw new Error(value.error || r.stderr);
  return value;
}
export class FileTools {
  constructor(owner, cx) {
    this.owner = owner; this.focus = cx.focus_handle(); this.client = `files-${Date.now()}-${Math.random().toString(36).slice(2)}`; this.query = InputState.new({ placeholder: "Find files…" }); this.path = InputState.new({ placeholder: "Path inside the selected folder…" });
    this.query.on("change", (_e, cx) => this.search(cx));
    this.query.on("submit", (_e, cx) => { if (this.results?.[this.at || 0]) this.select(this.results[this.at || 0], cx); });
  }
  show(mode, cx) {
    this.mode = mode; this.error = null; this.results = []; this.at = 0;
    if (["files", "content"].includes(mode)) { this.query.focus(); this.search(cx); }
    cx.notify();
  }
  search(cx) {
    const sequence = this.sequence = (this.sequence || 0) + 1;
    const root = this.owner.root, mode = this.mode, query = this.query.value(), matchCase = this.matchCase;
    this.searching = true;
    cx.spawn(async () => { try { await workspaceCall("search_cancel", { client: this.client, sequence }); } catch {} });
    cx.timer.after(150, cx => {
      if (sequence !== this.sequence) return;
      cx.spawn(async cx => {
        try {
          const result = await workspaceCall("search", { root, mode, query, matchCase, client: this.client, sequence });
          if (sequence !== this.sequence || root !== this.owner.root) return;
          this.results = result.items; this.at = 0; this.incomplete = result.incomplete; this.error = null;
        } catch (e) { if (sequence === this.sequence) this.error = e.message; }
        finally { if (sequence === this.sequence) { this.searching = false; cx.notify(); } }
      });
    }); cx.notify();
  }
  select(item, cx) { this.owner.show(item.path, cx, { line: item.line, column: item.column }); if (this.owner.palette) closeOverlay(props().overlay); }
  operation(operation, target, cx) {
    this.operationName = operation; this.target = target; this.prepared = null; this.error = null;
    const parent = this.targetDir ? target : target.split("/").slice(0, -1).join("/");
    this.path.set_value(["rename", "move", "duplicate"].includes(operation) ? target : parent ? parent + "/" : ""); this.mode = "operation"; this.path.focus(); cx.notify();
  }
  prepare(cx) {
    if (this.busy) return;
    this.busy = true; this.error = null;
    const root = this.owner.root, operation = this.operationName;
    const path = operation.startsWith("new_") ? this.path.value().trim() : this.target;
    const destination = ["rename", "move", "duplicate"].includes(operation) ? this.path.value().trim() : undefined;
    const proceed = cx => {
      cx.spawn(async cx => {
        try { if (root !== this.owner.root) throw new Error("The selected folder changed. Review the operation again."); this.prepared = await workspaceCall("file_prepare", { root, operation, path, destination }); if (!this.prepared.drafts.length) await this.apply(null, cx); }
        catch (e) { setShared("noodle.documents.request", null); this.error = e.message; }
        finally { this.busy = false; cx.notify(); }
      });
    };
    this.flushOwners(cx, proceed); cx.notify();
  }
  flushOwners(cx, proceed) {
    const root = this.owner.root;
    const id = `${Date.now()}-${Math.random()}`, owners = shared("noodle.documents") || {};
    const waiting = [...new Set(Object.values(owners).filter(d => d.root === root && panes().some(p => p.pane === d.pane)).map(d => d.key))];
    setShared("noodle.documents.request", { id });
    let attempts = 0;
    const poll = cx => {
      const ack = shared(`noodle.documents.ack.${id}`) || {};
      if (waiting.every(key => ack[key])) { setShared(`noodle.documents.ack.${id}`, null); proceed(cx); }
      else if (++attempts < 30) cx.timer.after(100, poll);
      else { setShared("noodle.documents.request", null); this.busy = false; this.error = "An editor has not checkpointed its draft. Save it before retrying."; cx.notify(); }
    };
    poll(cx); cx.notify();
  }
  async apply(resolution, cx) {
    const root = this.prepared.root;
    if (root !== this.owner.root) throw new Error("The selected folder changed. Review the operation again.");
    const result = await workspaceCall("file_apply", { prepared: this.prepared, resolution });
    if (result.needsDraftResolution) { this.prepared = result; return; }
    setShared("noodle.documents.request", null);
    this.undo = result.undo || this.undo; this.mode = null; this.contextOpen = null;
    setShared("noodle.files.changed", { ...result, root, sequence: Date.now() });
    this.owner.refresh(cx); cx.notify();
  }
  confirm(resolution, cx) {
    if (this.busy) return; this.busy = true;
    this.flushOwners(cx, cx => cx.spawn(async cx => { try { await this.apply(resolution, cx); } catch (e) { setShared("noodle.documents.request", null); this.error = e.message; } finally { this.busy = false; cx.notify(); } })); cx.notify();
  }
  restore(cx) {
    const id = this.undo; if (!id || this.busy) return;
    this.busy = true;
    cx.spawn(async cx => { try { const result = await workspaceCall("file_restore", { id }); this.undo = null; setShared("noodle.files.changed", { ...result, root: this.owner.root, sequence: Date.now() }); this.owner.refresh(cx); } catch (e) { setShared("noodle.documents.request", null); this.error = e.message; } finally { this.busy = false; cx.notify(); } });
  }
  dismiss(cx) {
    this.contextOpen = null; this.contextPoint = null; this.mode = null; this.prepared = null;
    setShared("noodle.documents.request", null); cx.notify();
  }
  history(cx) {
    const p = this.owner, root = p.git.root;
    if (!root) return;
    const path = `${p.root}/${this.target}`.slice(root.length + 1);
    p.show(this.target, cx);
    setShared(`git-file-preview.${focused().tab}.history`, { root, on: p.on, path, sequence: Date.now() });
    run("layout.select", { stack: "panel-body", child: "changes" }); this.dismiss(cx);
  }
  reveal(cx) {
    const path = this.target ? `${this.owner.root}/${this.target}` : this.owner.root;
    this.dismiss(cx);
    cx.spawn(async cx => { const result = await exec("open", ["-R", path]); if (result.code) { this.owner.error = result.stderr || "Finder could not reveal this item"; cx.notify(); } });
  }
  terminal(cx) {
    run("terminal.open", { folder: this.target ? `${this.owner.root}/${this.target}` : this.owner.root, place: "tab" }); this.dismiss(cx);
  }
  context(row, path, directory) {
    return row.on_mouse_down("right", () => { this.contextTarget = { path, directory }; });
  }
  contextArea(area, t, cx) {
    return area.relative().on_mouse_down("right", (event, cx) => {
      const target = this.contextTarget || { path: "", directory: true };
      this.contextTarget = null;
      if (!this.owner.root || this.busy) return;
      if (!event.local_position) return;
      // Mouse coordinates are window pixels; Herdr scales numeric layout lengths.
      const zoom = Number(settings().zoom) || 1;
      this.contextPoint = { x: event.local_position.x / zoom, y: event.local_position.y / zoom };
      this.contextOpen = target.path || "workspace"; this.target = target.path; this.targetDir = target.directory;
      this.mode = "menu"; this.error = null; this.menuRoot = this.owner.root; this.focus.focus(); cx.stop_propagation(); cx.notify();
    }).when(Boolean(this.contextPoint && this.contextOpen), el => el.child(
      Popup.new("files-context-menu", div().size(0)).absolute().left(this.contextPoint.x).top(this.contextPoint.y).anchor("top_left")
        .content(this.menu(t, cx).track_focus(this.focus).on_mouse_down_out((_event, cx) => { if (!this.busy) this.dismiss(cx); }))));
  }
  menu(t, cx) {
    const option = (id, label, icon, action, disabled = false, danger = false) => Button.new(`files-context-${id}`).h_flex().h(30).w_full().px(8).gap(8).items_center().justify_start().font_normal().text_size(12).rounded(4)
      .bg("#00000000").text_color(danger ? t.ansi1 : t.foreground).disabled(disabled || this.busy).hover(el => el.bg(t.hover))
      .on_click((_e, cx) => { if (this.menuRoot === this.owner.root) action(cx); else this.dismiss(cx); })
      .child(svg(icon).size(14).flex_none().text_color(t.muted)).child(label);
    const separator = () => div().h(1).my(4).mx(8).bg(t.border);
    const local = !this.owner.on, path = this.target;
    const copy = relative => cx => { cx.write_to_clipboard(relative ? path : path ? `${this.owner.root}/${path}` : this.owner.root); this.dismiss(cx); };
    return v_flex().w(this.mode === "operation" ? 350 : 240).p(6).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.dismiss(cx); cx.stop_propagation(); } })
      .when(this.mode === "operation", el => el.child(this.form(t, cx)))
      .when(this.mode !== "operation", el => el
        .child(option("new-file", "New File…", "mods/files-browser/new-file.svg", cx => this.operation("new_file", path, cx), !local))
        .child(option("new-folder", "New Folder…", "mods/files-browser/new-folder.svg", cx => this.operation("new_folder", path, cx), !local))
        .when(Boolean(path), el => el.child(separator())
          .child(option("rename", "Rename…", "mods/files-browser/rename.svg", cx => this.operation("rename", path, cx), !local))
          .child(option("move", "Move…", "mods/files-browser/move.svg", cx => this.operation("move", path, cx), !local))
          .when(!this.targetDir, el => el.child(option("duplicate", "Duplicate", "mods/files-browser/duplicate.svg", cx => this.operation("duplicate", path, cx), !local)))
          .child(option("trash", "Move to Trash…", "mods/files-browser/trash.svg", cx => this.operation("trash", path, cx), !local, true)))
        .child(separator())
        .child(option("copy-path", "Copy Path", "mods/git-file-preview/copy.svg", copy(false)))
        .child(option("copy-relative", "Copy Relative Path", "mods/git-file-preview/copy.svg", copy(true)))
        .when(Boolean(path), el => el.child(option("history", "View History", "mods/changes-graph/history.svg", cx => this.history(cx), !this.owner.git.root)))
        .when(this.targetDir, el => el.child(option("terminal", "Open in Terminal", "mods/files-browser/terminal.svg", cx => this.terminal(cx), !local)))
        .child(option("finder", "Reveal in Finder", "mods/files-browser/finder.svg", cx => this.reveal(cx), !local))
        .when(!path, el => el.child(separator())
          .child(option("tasks", "Run Task…", "mods/files-browser/terminal.svg", cx => { this.contextOpen = null; this.mode = "tasks"; this.owner.tasks.load(cx); }, !local))
          .when(Boolean(this.undo), el => el.child(option("undo-trash", "Undo Move to Trash", "mods/changes-graph/undo.svg", cx => { this.contextOpen = null; this.restore(cx); }, !local)))))
      .when(Boolean(this.error), el => el.child(div().px(8).py(8).text_size(12).text_color(t.ansi1).child(this.error)));
  }
  form(t, cx) {
    const button = (id, label, fn) => Button.new(id).h(28).px(8).rounded(5).text_size(12).disabled(Boolean(this.busy)).child(label).on_click((_e, cx) => fn(cx));
    return v_flex().p(8).gap(10)
      .child(div().font_semibold().child(({ new_file: "New File", new_folder: "New Folder", rename: "Rename", move: "Move", duplicate: "Duplicate File", trash: "Move to Trash?" })[this.operationName]))
      .when(this.operationName === "trash", el => el.child(div().truncate().child(this.target)))
      .when(this.operationName !== "trash", el => el.child(Input.new(this.path)))
      .when(Boolean(this.prepared?.drafts.length), el => el.child(div().text_size(12).child(`${this.prepared.drafts.length} unsaved draft(s). Save or discard before continuing.`)))
      .child(h_flex().gap(8).justify_end()
        .child(button("cancel-file-operation", "Cancel", cx => this.dismiss(cx)))
        .when(!this.prepared, el => el.child(button("prepare-file-operation", this.operationName === "trash" ? "Move to Trash" : "Save", cx => this.prepare(cx))))
        .when(Boolean(this.prepared?.drafts.length), el => el
          .child(button("save-before-operation", "Save & continue", cx => this.confirm("save", cx)))
          .child(button("discard-before-operation", "Discard & continue", cx => this.confirm("discard", cx)))));
  }
  palette(t, cx) {
    return v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.popover).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(52).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .on_key_down((e, cx) => { if (e.key === "down" || e.key === "up") { this.at = Math.max(0, Math.min((this.results?.length || 1) - 1, (this.at || 0) + (e.key === "down" ? 1 : -1))); cx.stop_propagation(); cx.notify(); } })
        .child(svg("mods/files-browser/search.svg").size(16).text_color(t.muted)).child(Input.new(this.query).flex_1().min_w(0))
        .child(div().text_size(11).text_color(t.muted).child("esc")))
      .child(this.resultsView(t, cx))
      .when(this.incomplete || this.error || this.searching, el => el.child(div().px(16).py(8).text_size(12).text_color(this.error ? t.ansi1 : t.muted).child(this.error || (this.searching ? "Searching…" : "Search limit reached. Narrow the query."))));
  }
  resultsView(t, cx) {
    return v_flex().id("file-search-results").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(6)
      .children((this.results || []).map((item, i) => div().id(`result-${i}`).min_h(28).px(10).py(6).rounded(5).cursor_pointer().when(this.at === i, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.select(item, cx)).child(div().truncate().child(`${item.path}${item.line ? `:${item.line}` : ""}`))
        .when(Boolean(item.text), el => el.child(div().truncate().text_size(11).text_color(t.muted).child(item.text)))));
  }
}
