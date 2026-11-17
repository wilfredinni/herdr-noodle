import { div } from "gpui-kit";
import { h_flex, Input, InputState, Button } from "gpui-base";

export class PreviewSearch {
  constructor(owner, cx) {
    this.owner = owner; this.matches = []; this.byKey = new Map(); this.at = 0;
    this.focus = cx.focus_handle();
    this.query = InputState.new({ placeholder: "Find in preview" });
    this.query.on("change", (_e, cx) => { this.invalidate(); this.find(cx); });
    this.query.on("submit", (e, cx) => this.find(cx, e.shift ? -1 : 1));
    cx.bind_keys?.(["cmd-f", "ctrl-f"].flatMap(keystroke => ["NoodlePreview", "NoodlePreview > Input"].map(context => ({ keystroke, action: "noodle.preview.find", context }))));
  }
  invalidate() { this.token = null; }
  sync() {
    const o = this.owner, token = [o.mode, o.layout, o.rows, o.source, o.review?.mode, o.review?.hunks, o.review?.confirm, o.review?.comparison, o.review?.pr, o.review?.log, this.query.value(), this.open];
    if (this.token?.every((value, i) => value === token[i])) return;
    this.token = token; this.matches = []; this.byKey = new Map(); this.at = 0;
    if (!this.open || !this.query.value()) return;
    const rows = o.mode === "source" ? (o.selection?.kind === "file" ? o.rows : o.source?.rows) || [] : o.rows;
    const splitIndex = new Map();
    if (o.mode === "diff" && o.layout === "split") o.split.forEach((pair, index) => { splitIndex.set(pair.before, index); splitIndex.set(pair.after, index); });
    const entries = o.mode === "review" ? o.review.searchEntries() : o.mode === "diff" || o.mode === "source"
      ? rows.map((row, index) => ({ key: row, text: row.text, index: splitIndex.get(row) ?? index })) : [];
    for (const entry of entries) {
      const ranges = [], query = this.query.value();
      for (let start = entry.text.indexOf(query); start >= 0; start = entry.text.indexOf(query, start + query.length)) {
        const match = { ...entry, start, end: start + query.length, number: this.matches.length };
        ranges.push(match); this.matches.push(match);
      }
      this.byKey.set(entry.key, ranges);
    }
  }
  show(cx) {
    this.open = true; this.find(cx);
    this.query.focus(); this.query.set_selected_range({ start: 0, end: this.query.value().length }); cx.notify();
  }
  close(cx) {
    this.open = false; this.owner.markdownView?.close_search(); this.invalidate(); this.focus.focus(); cx.notify();
  }
  find(cx, direction = 0) {
    this.sync();
    const o = this.owner;
    if (o.mode === "markdown") this.markdownLabel = o.markdownView ? o.markdownView.search(this.query.value(), direction) : "0/0";
    else if (this.matches.length) {
      this.at = (this.at + direction + this.matches.length) % this.matches.length;
      const match = this.matches[this.at];
      if (o.mode === "review") o.review.revealSearch(match);
      else o.scroll.scroll_to_item(match.index, "center");
    }
    cx.notify();
  }
  paint(text, key, spans, t, color = t.foreground, wrap = false) {
    this.sync();
    const ranges = this.byKey.get(key) || [], pieces = [];
    let offset = 0, at = 0;
    for (const span of spans || [{ text, color }]) {
      const end = offset + span.text.length;
      for (let start = offset; start < end;) {
        while (ranges[at]?.end <= start) at++;
        const match = ranges[at]?.start <= start ? ranges[at] : null;
        const next = Math.min(end, match ? match.end : ranges[at]?.start ?? end);
        const value = span.text.slice(start - offset, next - offset);
        for (const part of wrap ? value.split(/(\s+)/).filter(Boolean) : [value]) pieces.push(div().flex_none().text_color(typeof span.color === "number" ? t[`ansi${span.color}`] : span.color || color)
          .when(Boolean(match), el => el.bg(match.number === this.at ? "#ff6b0066" : "#ffb80038")).child(part));
        start = next;
      }
      offset = end;
    }
    return h_flex().min_w(0).when(wrap, el => el.flex_wrap()).children(pieces);
  }
  render(t) {
    this.sync();
    let label = `${this.matches.length ? this.at + 1 : 0}/${this.matches.length}`;
    if (this.owner.mode === "markdown") label = this.owner.markdownView?.status?.() || (this.owner.markdownView && this.markdownLabel) || "0/0";
    const button = (id, label, action) => Button.new(id).h(28).px(8).rounded(5).text_size(12).accessibility_label(label).child(label).on_click((_e, cx) => action(cx));
    return h_flex().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border).bg(t.background)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(cx); cx.stop_propagation(); } })
      .child(Input.new(this.query).h(28).flex_1().min_w(0).accessibility_label("Find in preview (case sensitive)"))
      .child(div().text_color(t.muted).child(this.query.value() && label === "0/0" ? "No matches" : label))
      .child(button("preview-find-previous", "Previous", cx => this.find(cx, -1)))
      .child(button("preview-find-next", "Next", cx => this.find(cx, 1)))
      .child(button("preview-find-close", "Close", cx => this.close(cx)));
  }
}
