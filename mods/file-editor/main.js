import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { shared, setShared, theme, props, focused, panes, run } from "herdr";
import { Documents } from "./documents.js";
import { fileIcon } from "./fileIcons.js";

export default class FileEditor extends View {
  init(_props, cx) {
    this.selectionKey = props()?.selectionKey || _props?.selectionKey || "file-editor.unselected";
    const direct = props() || _props || {};
    if (direct.root && direct.path) this.direct = { root: direct.root, on: null, file: { path: direct.path }, hash: null };
    this.mode = "source";
    this.documents = new Documents(this, cx);
    this.refresh(cx);
  }

  editable() {
    const s = this.selection;
    return Boolean(this.documents && s?.file && !s.on && !s.hash && s.diffMode !== "staged" && s.file.status !== "D" && !/\.(png|jpe?g)$/i.test(s.file.path));
  }

  refresh(cx, force = false) {
    const selection = shared(this.selectionKey) || this.direct || null;
    const context = JSON.stringify(selection);
    if (!force && context === this.context) return;
    this.context = context; this.selection = selection;
    if (selection?.file && this.editable()) this.documents.edit(cx);
    cx.notify();
  }

  openFile(file, _commit, cx, options = {}) {
    setShared(this.selectionKey, { ...this.selection, file, ...options });
    this.refresh(cx); cx.notify();
  }

  selectFile(cx) {
    this.direct = null; this.selection = null; this.context = JSON.stringify(null);
    setShared(this.selectionKey, null); cx.notify();
  }

  closePane() {
    const tab = focused()?.tab, pane = panes().find(p => p.tab === tab && p.mod === "file-editor");
    if (pane) run("pane.close", { pane: pane.pane });
  }

  async close() { await this.documents?.close(); }

  render(cx) {
    if (JSON.stringify(shared(this.selectionKey) || this.direct || null) !== this.context && !this.refreshPending) {
      this.refreshPending = true;
      cx.spawn(cx => { this.refreshPending = false; this.refresh(cx); });
    }
    const t = theme(), s = this.selection, file = s?.file;
    const icon = file ? fileIcon(file.path.split(/[\\/]/).pop()) : null;
    const ok = this.editable();
    return v_flex().id("file-editor").size_full().min_w(0).min_h(0).bg(t.canvas).text_color(t.foreground).text_size(12)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.background)
        .child(Button.new("close-editor").size(26).flex().items_center().justify_center().flex_none().rounded(4).bg("#00000000").text_color(t.muted)
          .accessibility_label("Close editor").tooltip("Close editor").hover(el => el.bg(t.hover))
          .on_click(() => this.closePane()).child(svg("mods/pane/close.svg").size(14)))
        .when(Boolean(icon), el => el.child(svg(icon.path).size(16).flex_none().text_color(t[icon.color])))
        .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(file ? `${s.root}/${file.path}` : "File editor")
          .child(file ? file.path.split(/[\\/]/).pop() : "File editor"))
        .child(div().flex_none().text_size(11).text_color(t.muted)
          .child(!file ? "" : !ok ? "Read-only" : this.documents.current?.dirty ? "• Unsaved" : this.documents.current ? "Saved" : "Opening…")))
      .child(!file
        ? div().flex_1().p(16).text_color(t.muted).child("Select a file in Files to start editing.")
        : !ok
          ? div().flex_1().p(16).text_color(t.muted).child(s.on ? "Editing remote files is not supported." : "Select a local text file in Files to edit.")
          : this.documents.render(t, cx));
  }
}
