import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Scrollbar, v_virtual_list, TextView } from "gpui-base";
import { shared, exec, readTextFile, watchFolder, theme, settings, props, focused, panes } from "herdr";
import { readDiff, readFile, readMarkdown, isMarkdown } from "./content.js";

export default class FilePreview extends View {
  init(_props, cx) {
    this.selectionKey = props()?.selectionKey || _props?.selectionKey || "git-file-preview.unselected"; this.rows = []; this.mode = "diff"; this.version = 0;
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
      const sameFile = previous && previous.root === selection.root && previous.on === selection.on && previous.file.path === selection.file.path && previous.hash === selection.hash && previous.kind === selection.kind && previous.diffMode === selection.diffMode;
      if (!sameFile) this.mode = "diff";
      this.rows = []; this.result = null; this.markdown = null; this.markdownError = null;
    }
    let changed = Boolean(this.error);
    this.dirty = false;
    this.context = context; this.selection = selection; this.error = null; this.loading = true; this.markdownLoading = false;
    const version = ++this.version;
    cx.spawn(async cx => {
      try {
        const result = await (selection.kind === "file" ? readFile : readDiff)(selection, { exec, readTextFile }, this.result);
        if (version !== this.version) return;
        if (result === this.result) {
          if (this.mode === "markdown") await this.loadMarkdown(cx);
          return;
        }
        this.result = result; changed = true;
        this.rows = result.rows; this.truncated = result.truncated; this.syntaxError = result.syntaxError;
        this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 72));
        this.watch(selection.root, selection.on, cx);
        if (this.mode === "markdown") await this.loadMarkdown(cx);
        else this.markdown = null;
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

  close() { this.watched = null; }

  selectMode(mode, cx) {
    this.mode = mode;
    if (mode === "markdown" && !this.markdown && !this.markdownLoading) cx.spawn(cx => this.loadMarkdown(cx));
    cx.notify();
  }

  diffRow({ kind, number, text, spans, change, deletedBefore, deletedAfter }, t) {
    if (kind === "@") return div().w_full().px(12).h(22).flex_none().truncate().bg(t.raised).text_color(t.muted).child(text);
    return h_flex().w_full().h(22).flex_none().gap(10)
      .when(kind === "+", el => el.bg(t.ansi2 + "18")).when(kind === "-", el => el.bg(t.ansi1 + "18"))
      .child(div().w(38).flex_none().text_right().text_color(t.muted).child(number === undefined ? "" : String(number)))
      .when(this.selection?.kind === "file", el => el.child(div().w(6).h(22).flex_none().relative()
        .when(Boolean(change), e => e.child(div().absolute().left(1).top(3).w(3).h(16).bg(change === "added" ? t.ansi2 : t.ansi3)))
        .when(Boolean(deletedBefore), e => e.child(svg("mods/git-file-preview/deleted.svg").w(6).h(5).absolute().left(0).top(0).text_color(t.ansi1)))
        .when(Boolean(deletedAfter), e => e.child(svg("mods/git-file-preview/deleted.svg").w(6).h(5).absolute().left(0).bottom(0).text_color(t.ansi1)))))
      .when(this.selection?.kind !== "file", el => el.child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.muted).child(kind === "+" || kind === "-" ? kind : "")))
      .child(h_flex().flex_1().min_w(0).font_normal().children((spans || [{ text, color: null }]).map(span =>
        div().flex_none().text_color(typeof span.color === "number" ? t[`ansi${span.color}`] : span.color || t.foreground).child(span.text))));
  }

  render(cx) {
    if (JSON.stringify(shared(this.selectionKey)) !== this.context) this.refresh(cx);
    else if (this.dirty && this.active()) this.refresh(cx, true);
    const t = theme(), file = this.selection?.file;
    return v_flex().size_full().min_w(0).min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .child(h_flex().h(44).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(file?.path || "").child(file?.path || "File preview"))
        .when(Boolean(this.selection), el => el.child(div().px(6).py(2).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.selection.kind === "file" ? "File" : this.selection.hash ? this.selection.hash.slice(0, 8) : this.selection.diffMode === "staged" ? "Staged" : this.selection.diffMode === "unstaged" ? "Unstaged" : "Uncommitted")))
        .when(Boolean(file && isMarkdown(file.path)), el => el.child(h_flex().gap(3).p(2).rounded(6).bg(t.raised)
          .children(["diff", "markdown"].map(mode => Button.new(`file-mode-${mode}`).h_flex().h(26).px(8).gap(5).items_center().rounded(4)
            .bg(this.mode === mode ? t.selected : t.raised).text_color(this.mode === mode ? t.foreground : t.muted)
            .accessibility_label(mode === "diff" ? (this.selection.kind === "file" ? "Show source" : "Show file diff") : "Render Markdown preview").hover(e => e.bg(t.hover)).on_click((_e, cx) => this.selectMode(mode, cx))
            .child(mode === "diff" ? (this.selection.kind === "file" ? "Source" : "Diff") : "Preview"))))))
      .when(this.mode === "diff", el => el
        .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .child(div().id("file-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diffWidth || 300).h_full()
              .child(v_virtual_list("file-diff", this.rows.length, 22, i => String(i), range => this.rows.slice(range.start, range.end).map(row => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("file-diff").viewport_from_layout().absolute().inset_0())
          .when(Boolean(this.error) || !file || (!this.rows.length && this.loading), e => e.child(div().absolute().top(16).px(16).text_color(this.error ? t.ansi1 : t.muted).child(this.error || (file ? "Loading file…" : "Select a file from Files, Changes or Git Graph")))))
        .when(Boolean(this.syntaxError), e => e.child(div().px(14).py(6).text_color(t.muted).child(this.syntaxError)))
        .when(this.truncated, e => e.child(div().px(14).py(6).text_color(t.muted).child(this.selection.kind === "file" ? "Source preview limited to 5,000 lines or 400,000 characters" : "Showing the first 1,500 diff lines"))))
      .when(this.mode === "markdown", el => el
        .when(Boolean(this.markdown?.deleted), e => e.child(div().px(20).py(8).text_color(t.muted).border_b(1).border_color(t.border).child("Deleted file · showing its previous version")))
        .child(v_flex().id("markdown-document").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(24).items_center()
          .when(!this.markdown, e => e.child(div().w_full().text_color(this.markdownError ? t.ansi1 : t.muted).child(this.markdownError || "Rendering Markdown…")))
          .when(Boolean(this.markdown), e => e.child(div().w_full().max_w(760).font_normal().text_size(15).line_height("24px").font_family(settings().ui_font ?? "Geist")
            .child(TextView.markdown(`markdown-${this.context}-${this.markdownVersion}`, this.markdown.text || "*This document is empty.*").selectable(true).scrollable(false).w_full().text_color(t.foreground)))))
        .when(this.markdown?.truncated, e => e.child(div().px(20).py(6).text_color(t.muted).child("Markdown preview limited to the first 200,000 characters"))));
  }
}
