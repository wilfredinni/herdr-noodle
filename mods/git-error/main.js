import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";

export default class GitError extends View {
  init(_props, cx) {
    this.focus = cx.focus_handle(); this.focus.focus();
  }

  render() {
    const t = theme(), p = props() ?? {};
    return v_flex().id("git-error-dialog").w_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground).track_focus(this.focus)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().gap(10)
        .child(div().flex_1().min_w(0).text_size(14).font_semibold().line_height("20px").child(p.title ?? "Git operation stopped"))
        .child(Button.new("git-error-close").size(24).flex_none().flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted)
          .accessibility_label("Close").hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.bg(t.hover))
          .on_click(() => closeOverlay(p.overlay)).child(svg("mods/pane/close.svg").size(12))))
      .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(p.message ?? "Review the details before trying again."))
      .when(Boolean(p.detail), el => el.child(div().id("git-error-output").max_h(170).overflow_y_scroll().text_size(11).line_height("17px")
        .font_family("JetBrains Mono").text_color(t.muted).child(p.detail)));
  }
}
