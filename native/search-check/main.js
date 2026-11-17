import { View, div } from "gpui-kit";
import { v_flex, Input, InputState, Editor, EditorState } from "gpui-base";

export default class SearchCheck extends View {
  init() {
    const value = "😀 match first\nmatch second\nmatch last\n";
    this.code = EditorState.new({ value, readonly: true, font_size: 18 });
    const check = (actual, expected) => { if (actual !== expected) throw new Error(`${actual} != ${expected}`); };
    check(this.code.search("match"), "1/3");
    check(this.code.selected_range().start, 3);
    check(this.code.search("match", 1), "2/3");
    check(this.code.search("match", -1), "1/3");
    check(this.code.search("match", -1), "3/3");
    check(this.code.search("match", 1), "1/3");
    check(this.code.search("missing"), "0/0");
    check(this.code.search(""), "0/0");
    let rejected = false;
    try { this.code.search("match", 2); } catch { rejected = true; }
    check(rejected, true);
    this.code.set_value("😀 match\nnew match\n");
    check(this.code.search("match"), "1/2");
    this.code.set_value(value);
    this.code.close_search();
    check(this.code.value(), value);
    this.code.search("match");
    this.code.search("match", 1);
    this.query = InputState.new({ value: "match" });
    this.query.on("change", () => this.code.search(this.query.value()));
    this.query.on("submit", e => this.code.search(this.query.value(), e.shift ? -1 : 1));
    this.query.focus();
  }
  render() {
    return v_flex().size_full().p(16).gap(12)
      .child(div().child("Native search check: all matches marked; second match active"))
      .child(Input.new(this.query).h(32))
      .child(Editor.new(this.code).flex_1().min_h(0));
  }
}
