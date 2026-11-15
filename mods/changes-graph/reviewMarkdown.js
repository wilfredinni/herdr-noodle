import { div } from "gpui-kit";
import { v_flex, h_flex, Button, TextView, Scrollbar, v_virtual_list } from "gpui-base";

export function reviewSegments(value) {
  const lines = value.split("\n"), parts = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/.exec(lines[i]);
    if (!fence) continue;
    const marker = fence[1], language = fence[2].trim().split(/\s/)[0].toLowerCase();
    let end = i + 1;
    for (; end < lines.length; end++) {
      const close = /^ {0,3}([`~]+)[ \t]*\r?$/.exec(lines[end]);
      if (close && close[1].length >= marker.length && [...close[1]].every(char => char === marker[0])) break;
    }
    if (["diff", "patch"].includes(language)) {
      const markdown = lines.slice(start, i).join("\n");
      if (markdown.trim()) parts.push({ kind: "markdown", text: markdown });
      parts.push({ kind: "diff", text: lines.slice(i + 1, end).join("\n") + (end < lines.length && end > i + 1 ? "\n" : "") });
      start = end + 1;
    }
    i = end;
  }
  const tail = lines.slice(start).join("\n");
  if (tail.trim()) parts.push({ kind: "markdown", text: tail });
  return parts;
}

export function diffColor(line) {
  return line.startsWith("@@") || line.startsWith("diff --git") ? "ansi4"
    : /^(?:\+\+\+|---)(?:\s|$)/.test(line) ? "muted"
    : line.startsWith("+") ? "ansi2" : line.startsWith("-") ? "ansi1" : "foreground";
}

export function reviewMarkdown(id, value, t) {
  return v_flex().min_w(0).gap(10).children(reviewSegments(value || "No description.").map((part, index) => {
    const key = `${id}-${index}`;
    if (part.kind === "markdown") return TextView.markdown(key, part.text).text_size(12).line_height("19px").text_color(t.foreground);
    const lines = part.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const row = line => div().h(19).flex_none().whitespace_nowrap().font_family("JetBrains Mono").text_size(12).line_height("19px").text_color(t[diffColor(line)]).child(line || " ");
    const width = lines.reduce((width, line) => Math.max(width, line.length * 7.3), 200);
    return v_flex().id(key).min_w(0).flex_none().p(10).gap(6).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().h(22).items_center().justify_between()
        .child(div().text_size(10).text_color(t.muted).child("diff"))
        .child(Button.new(`${key}-copy`).h(22).px(6).rounded(4).bg("#00000000").text_size(11).text_color(t.muted)
          .accessibility_label("Copy diff code").tooltip("Copy diff code").hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
          .on_click((_e, cx) => cx.write_to_clipboard(part.text)).child("Copy code")))
      .child(div().id(key + "-x").h(Math.min(360, lines.length * 19)).relative().overflow_x_scrollbar()
        .child(v_virtual_list(key + "-lines", lines.length, 19, i => String(i), range => lines.slice(range.start, range.end).map(row)).w(width).min_w("100%").h_full())
        .child(Scrollbar.vertical(key + "-lines").absolute().inset_0()));
  }));
}
