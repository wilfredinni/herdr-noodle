import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Button, Popover } from "gpui-base";
import { spaces, agents, theme, focused, panes } from "herdr";
import { CONNECTIONS, readConnection, mergeReading, stale, quotaMeter, modeLabel, age, resetIn } from "./connections.js";

export default class WorkspaceUsage extends View {
  init(_props, cx) {
    this.records = new Map(); this.pending = new Set(); this.machine = undefined; this.directory = undefined; this.open = false;
    this.focus = cx.focus_handle();
    this.syncContext(cx);
    cx.timer.every(300000, cx => this.refresh(cx));
    cx.timer.every(30000, cx => cx.notify());
  }

  key(connection, machine = this.machine, directory = this.directory) { return JSON.stringify([machine, connection.id, connection.id === "opencode" ? directory ?? null : null]); }
  record(connection) { return this.records.get(this.key(connection)); }
  loading() { return CONNECTIONS.some(connection => this.pending.has(this.key(connection))); }

  syncContext(cx) {
    const space = spaces().find(space => space.active), focus = focused();
    const machine = space?.machine ?? null;
    const directory = focus?.cwd || panes().find(pane => pane.tab === focus?.tab && pane.terminal)?.cwd || space?.folder || null;
    if (machine === this.machine && directory === this.directory) return;
    this.machine = machine; this.directory = directory; this.open = false; this.refresh(cx, true);
  }

  refresh(cx, cached = false) {
    const machine = this.machine, directory = this.directory;
    for (const connection of CONNECTIONS) {
      const key = this.key(connection, machine, directory), previous = this.records.get(key);
      if (this.pending.has(key) || (cached && previous && Date.now() / 1000 - previous.reading.checkedAt < 300)) continue;
      this.pending.add(key);
      cx.spawn(async cx => {
        try {
          const reading = await readConnection(connection, machine, connection.id === "opencode" ? directory : null);
          this.records.set(key, mergeReading(this.records.get(key), reading));
        } catch {
          this.records.set(key, mergeReading(this.records.get(key), { state: "error", mode: "unknown", checkedAt: Date.now() / 1000, note: "Could not read usage. Check the connection and Python 3 installation." }));
        } finally { this.pending.delete(key); cx.notify(); }
      });
    }
    cx.notify();
  }

  icon(connection, size = 13) {
    return connection.tint ? svg(connection.icon).size(size).flex_none() : image(connection.icon).size(size).flex_none();
  }

  color(percent, t) { return percent == null ? t.dim : percent >= 90 ? t.ansi1 : percent >= 70 ? t.ansi3 : t.ansi2; }

  progress(window, width, height, t) {
    const meter = quotaMeter(window), color = this.color(meter.percent, t);
    return div().w(width).h(height).flex_none().relative()
      .child(div().size_full().rounded(2).bg(t.border).overflow_hidden()
        .when(meter.percent != null && meter.percent > 0, el => el.child(div().h_full().w(`${meter.percent}%`).min_w(3).rounded(2).bg(color))))
      .when(meter.tick != null, el => el.child(div().absolute().top(-2).bottom(-2).left(`${meter.tick * 100}%`).w(1).bg(t.muted).opacity(0.65)));
  }

  compactQuota(connection, window, t) {
    const meter = quotaMeter(window), value = meter.percent == null ? "—" : `${Math.round(meter.percent)}%`;
    return h_flex().flex_none().gap(5).items_center().tooltip(`${connection.name} · ${window.label} · ${value} used\n${resetIn(window.resetsAt)}`)
      .child(div().max_w(54).truncate().text_size(10.5).text_color(t.dim).child(meter.label))
      .child(this.progress(window, 44, 4, t))
      .child(div().text_size(11).text_color(meter.percent >= 70 ? this.color(meter.percent, t) : t.muted).child(value));
  }

  quota(window, dimmed, t) {
    const expired = window.resetsAt != null && window.resetsAt <= Date.now() / 1000;
    return v_flex().gap(4).when(dimmed, el => el.opacity(0.55))
      .child(h_flex().gap(8).items_center().text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(window.label))
        .child(div().text_color(t.dim).child(resetIn(window.resetsAt)))
        .child(div().w(34).text_right().text_color(expired ? t.dim : this.color(window.usedPercent, t)).child(expired ? "—" : `${Math.round(window.usedPercent)}%`)))
      .child(this.progress(window, "100%", 3, t));
  }

  provider(connection, t) {
    const record = this.record(connection), reading = record?.reading, good = record?.good;
    const dimmed = stale(record), pending = this.pending.has(this.key(connection));
    const status = pending ? "Reading…" : reading?.state === "missing" ? "Not installed" : good ? age(good.checkedAt) : "Unavailable";
    return v_flex().gap(8)
      .child(h_flex().gap(7).items_center()
        .child(this.icon(connection, 15)).child(div().font_semibold().child(connection.name))
        .when(Boolean(good), el => el.child(div().text_size(10.5).text_color(t.muted).child(modeLabel(good.mode))))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(dimmed ? t.ansi3 : t.dim).child(dimmed ? `Last reading · ${age(good.checkedAt)}` : status)))
      .when(Boolean(reading?.note) && ["error", "unavailable"].includes(reading?.state), el => el.child(div().text_size(11).line_height("16px").text_color(reading?.state === "error" ? t.ansi3 : t.dim).child(reading.note)))
      .children((good?.windows ?? []).map(window => this.quota(window, dimmed, t)))
      .when(Boolean(good?.go?.note), el => el.child(div().text_size(11).line_height("16px").text_color(good.go.state === "error" ? t.ansi3 : t.muted).child(good.go.note)));

  }

  details(t) {
    const missing = CONNECTIONS.filter(connection => this.record(connection)?.reading?.state === "missing");
    const installed = CONNECTIONS.filter(connection => !missing.includes(connection));
    return v_flex().w(400).p(12).gap(12).bg(t.popover).border_1().border_color(t.border).rounded(8).shadow_md().text_size(12).text_color(t.foreground).track_focus(this.focus)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.open = false; cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child("AI usage"))
        .child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(this.machine ?? "This computer"))
        .child(Button.new("ai-usage-refresh").size(24).flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted).disabled(this.loading())
          .accessibility_label("Refresh AI usage").tooltip("Refresh usage").hover(el => el.bg(t.hover)).on_click((_e, cx) => this.refresh(cx))
          .child(svg(this.loading() ? "mods/workspace-chrome/spinner.svg" : "mods/changes-graph/fetch.svg").size(13).when(this.loading(), el => el.spin(900)))))
      .child(v_flex().max_h(500).overflow_y_scroll().gap(12).children(installed.flatMap((connection, i) => [
        ...(i ? [div().h(1).flex_none().bg(t.border)] : []), this.provider(connection, t),
      ]))
        .when(missing.length > 0, el => el.child(v_flex().pt(10).gap(8).border_t(1).border_color(t.border)
          .child(div().text_size(10.5).text_color(t.dim).child("Not installed"))
          .child(h_flex().gap(16).items_center().children(missing.map(connection => h_flex().gap(6).items_center().opacity(0.6)
            .child(this.icon(connection)).child(div().text_size(11).text_color(t.muted).child(connection.name))))))))
      .child(div().text_size(10.5).text_color(t.dim).child("Updates every 5 minutes · Uses your CLI sign-ins"));
  }

  render(cx) {
    this.syncContext(cx);
    const t = theme(), space = spaces().find(space => space.active), list = agents();
    const needs = list.filter(agent => agent.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const visible = CONNECTIONS.map(connection => ({ connection, record: this.record(connection) }))
      .filter(item => item.record?.good || item.record?.reading?.installed === true);
    const trigger = Button.new("ai-usage-toggle").h_flex().h(24).flex_none().px(5).gap(12).items_center().rounded(5).bg(this.open ? t.hover : "#00000000").font_normal().text_size(11.5).text_color(t.muted)
      .accessibility_label("AI usage and connections").tooltip("AI usage and connections").hover(el => el.bg(t.hover).text_color(t.foreground))
      .when(!visible.length, el => el.child(this.loading() ? "Reading AI usage…" : "AI usage"))
      .children(visible.flatMap(({ connection, record }, i) => [
        ...(i ? [div().w(1).h(12).flex_none().bg(t.border)] : []),
        h_flex().flex_none().gap(8).items_center().tooltip(connection.name).when(stale(record), el => el.opacity(0.55))
          .child(this.icon(connection))
          .children((record.good?.windows ?? []).map(window => this.compactQuota(connection, window, t)))
          .when(!record.good?.windows?.length, el => el.child(div().text_color(t.dim).child("—"))),
      ]));
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1().min_w(0))
      .child(Popover.new("ai-usage").open(this.open).anchor("bottom_right").track_focus(this.focus)
        .on_open_change((open, cx) => { this.open = open; cx.notify(); }).trigger(trigger)
        .when(this.open, el => el.content(this.details(t))));
  }
}
