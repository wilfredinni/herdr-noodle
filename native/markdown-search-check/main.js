import { View, div } from "gpui-kit";
import { v_flex, Input, InputState, TextView, TextViewState } from "gpui-base";

export default class MarkdownSearchCheck extends View {
  init() {
    const check = (actual, expected) => { if (actual !== expected) throw new Error(`${actual} != ${expected}`); };
    this.document = TextViewState.markdown("# Search\n\n😀 **match** first\n\n`match` second\n\n[match](https://example.invalid)\n");
    check(this.document.value().includes("**"), false);
    check(this.document.search("match"), "1/3");
    check(this.document.status(), "1/3");
    check(this.document.search("match", 1), "2/3");
    check(this.document.search("match", -1), "1/3");
    check(this.document.search("match", -1), "3/3");
    check(this.document.search("match", 1), "1/3");
    check(this.document.search("match first"), "1/1");
    check(this.document.search("missing"), "0/0");
    check(this.document.search("example.invalid"), "0/0");
    let rejected = false;
    try { this.document.search("match", 1.5); } catch { rejected = true; }
    check(rejected, true);
    this.document.close_search();
    this.document.search("match"); this.document.search("match", 1);
    const released = TextViewState.markdown("temporary"); released.release();
    rejected = false; try { released.search("temporary"); } catch { rejected = true; } check(rejected, true);
    this.query = InputState.new({ value: "match" });
    this.query.on("change", () => this.document.search(this.query.value()));
    this.query.on("submit", e => this.document.search(this.query.value(), e.shift ? -1 : 1));
    this.query.focus();
  }
  render() {
    return v_flex().size_full().p(16).gap(12)
      .child(div().child("Rendered Markdown search: matches yellow, current match orange"))
      .child(Input.new(this.query).h(32))
      .child(TextView.new(this.document).scrollable(true).selectable(true).flex_1().min_h(0));
  }
}
