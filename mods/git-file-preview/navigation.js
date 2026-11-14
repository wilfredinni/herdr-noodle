import { div } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { shared, setShared } from "herdr";

export class Navigation {
  constructor(owner) { this.owner = owner; this.items = []; this.at = -1; }
  record(selection) {
    if (!selection?.file) return;
    const { root, on, file, hash, parent, kind, diffMode, gitRoot, sourcePane } = selection;
    const item = { root, on, file, hash, parent, kind, diffMode, gitRoot, sourcePane, navigation: selection.navigation };
    const key = x => JSON.stringify([x.root, x.on, x.file?.path, x.hash, x.diffMode, x.navigation]);
    if (this.moving) this.moving = false;
    else if (!this.items[this.at] || key(this.items[this.at]) !== key(item)) { this.items = this.items.slice(0, this.at + 1); this.items.push(item); if (this.items.length > 50) this.items.shift(); this.at = this.items.length - 1; }
    setShared("noodle.recent", [item, ...(shared("noodle.recent") || []).filter(x => key(x) !== key(item))].slice(0, 30));
  }
  go(delta, cx) {
    const item = this.items[this.at + delta]; if (!item) return;
    this.at += delta; this.moving = true; setShared(this.owner.selectionKey, item); this.owner.refresh(cx); cx.notify();
  }
  render(t, cx) {
    const button = (id, label, fn, disabled = false) => Button.new(id).h(28).px(8).text_size(12).rounded(5).disabled(disabled).on_click((_e, cx) => fn(cx)).child(label);
    const s = this.owner.selection;
    return v_flex().flex_none()
      .child(h_flex().px(12).py(6).gap(6).items_center()
        .child(button("navigate-back", "Back", cx => this.go(-1, cx), this.at <= 0))
        .child(button("navigate-forward", "Forward", cx => this.go(1, cx), this.at >= this.items.length - 1))
        .child(button("pin-file", "Pin file", cx => { if (s?.file) setShared("noodle.pinned", [s, ...(shared("noodle.pinned") || []).filter(x => x.root !== s.root || x.file?.path !== s.file.path)].slice(0, 20)); cx.notify(); }, !s?.file))
        .child(button("recent-files", "Recent / pinned", cx => { this.open = !this.open; cx.notify(); })))
      .when(this.open, el => el.child(v_flex().id("recent-file-picker").max_h(220).overflow_y_scrollbar().px(12).py(8).gap(6)
        .children([...(shared("noodle.pinned") || []), ...(shared("noodle.recent") || [])].map((item, i) => h_flex().gap(6).items_center()
          .child(button(`recent-file-${i}`, `${item.root.split('/').pop()}/${item.file?.path || ""}${item.hash ? ` · ${item.hash.slice(0, 8)}` : ""}`, cx => { this.open = false; setShared(this.owner.selectionKey, item); this.owner.refresh(cx); cx.notify(); }))
          .when(i < (shared("noodle.pinned") || []).length, el => el.child(button(`unpin-${i}`, "Unpin", cx => { setShared("noodle.pinned", (shared("noodle.pinned") || []).filter(x => x !== item)); cx.notify(); })))))));
  }
}
