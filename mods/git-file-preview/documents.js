import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, Input, InputState, Button } from "gpui-base";
import { exec, appHome, writeTextFile, settings, shared, setShared, panes, run } from "herdr";

async function call(action, request) {
  const r = await exec("python3", [`${appHome()}/helpers/noodle/workspace.py`, action, JSON.stringify({ home: appHome(), ...request })]);
  let data; try { data = JSON.parse(r.stdout); } catch { throw new Error(r.stderr || "The workspace helper is unavailable"); }
  if (r.code || data.error) throw new Error(data.error || r.stderr);
  return data;
}
const language = path => ({ js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", md: "markdown", rs: "rust", yml: "yaml" })[path.split('.').pop()] || path.split('.').pop();
export const rawText = (value, doc) => doc.normalizedCRLF ? value.replace(/\r?\n/g, '\r\n') : value;

export class Documents {
  constructor(owner, cx) {
    this.owner = owner; this.open = new Map(); this.trail = []; this.at = -1;
    this.destination = InputState.new({ placeholder: "New path inside this folder…" });
    this.line = InputState.new({ placeholder: "Line number" }); this.note = InputState.new({ placeholder: "Note for your agent…" });
    cx.bind_keys?.([{ keystroke: "cmd-s", action: "noodle.save", context: "NoodleEditor" }]);
    cx.timer.every(500, cx => this.requests(cx));
  }
  job(cx, task) {
    if (this.busy) return;
    this.busy = true; this.error = null;
    cx.spawn(async cx => { try { await task(cx); } catch (e) { this.error = String(e.message || e); } finally { this.busy = false; cx.notify(); } }); cx.notify();
  }
  edit(cx) {
    const s = this.owner.selection;
    if (!s?.file || s.on) return;
    const existing = [...this.open.values()].find(d => d.root === s.root && d.path === s.file.path);
    if (existing) { this.current = existing; this.owner.mode = "edit"; cx.notify(); return; }
    this.job(cx, async cx => {
      const data = await call("document_open", { root: s.root, path: s.file.path });
      const owners = shared("noodle.documents") || {}, other = owners[data.id];
      if (other && other.key !== this.owner.selectionKey && panes().some(p => p.pane === other.pane)) {
        run("pane.focus", { pane: other.pane }); return;
      }
      let doc = this.open.get(data.id);
      if (!doc) {
        if (this.open.size >= 20) throw new Error("Close an open file before opening another editor (20-file limit)");
        const input = EditorState.new({ value: data.draft, language: language(data.path), line_numbers: true, folding: true, soft_wrap: false, font_family: settings().font_family || "JetBrains Mono", font_size: 13 });
        doc = { ...data, input, selection: { ...s, hash: null, parent: null, commit: null, diffMode: null, kind: "file" }, dirty: data.dirty };
        // Some native editor versions normalize CRLF on input. Restore that convention on save.
        doc.normalizedCRLF = data.draft.includes('\r\n') && input.value() === data.draft.replaceAll('\r\n', '\n');
        if (input.value() !== data.draft && !doc.normalizedCRLF) { input.release(); throw new Error("This Herdr editor changes the original text. Editing was cancelled."); }
        this.open.set(doc.id, doc);
        input.on("change", (_e, cx) => {
          doc.dirty = rawText(input.value(), doc) !== doc.base; doc.change = (doc.change || 0) + 1;
          const change = doc.change; this.publish(doc);
          cx.timer.after(200, cx => { if (change === doc.change) this.checkpoint(doc, cx); }); cx.notify();
        });
      }
      this.current = doc; this.owner.mode = "edit";
      this.publish(doc); cx.notify();
    });
  }
  publish(doc) {
    const pane = panes().find(p => p.mod === "git-file-preview" && p.props?.selectionKey === this.owner.selectionKey) || panes().find(p => p.mod === "git-file-preview" && `git-file-preview.${p.tab}` === this.owner.selectionKey);
    setShared("noodle.documents", { ...(shared("noodle.documents") || {}), [doc.id]: { key: this.owner.selectionKey, pane: pane?.pane, root: doc.root, path: doc.path, dirty: doc.dirty } });
  }
  async flush(doc) {
    if (doc.flushing) await doc.flushing;
    const value = rawText(doc.input.value(), doc);
    if (value === doc.inputValue) return;
    doc.flushing = (async () => {
      await writeTextFile(doc.inputPath, value, doc.inputValue);
      doc.inputValue = value;
      const result = await call("document_checkpoint", { id: doc.id });
      doc.revision = result.revision;
    })();
    try { await doc.flushing; } finally { doc.flushing = null; }
    if (rawText(doc.input.value(), doc) !== doc.inputValue) await this.flush(doc);
  }
  checkpoint(doc, cx) {
    if (doc.closed) return;
    cx.spawn(async cx => { try { await this.flush(doc); } catch (e) { this.error = `Draft recovery failed: ${e.message || e}`; cx.notify(); } });
  }
  save(cx, as = false) {
    const doc = this.current; if (!doc) return;
    this.job(cx, async cx => {
      await this.flush(doc);
      if (as) {
        const path = this.destination.value().trim();
        const prepared = await call("file_prepare", { root: doc.root, path, operation: "new_file" });
        // Reserve with exclusive create, then use the native snapshot-checked writer.
        await call("file_apply", { prepared });
        await writeTextFile(`${doc.root}/${path}`, doc.inputValue, "");
        this.saveAs = false; this.owner.openFile({ path }, null, cx, { kind: "file", hash: null, commit: null });
        return;
      }
      try {
        await writeTextFile(doc.absolute, doc.inputValue, doc.base);
        const result = await call("document_saved", { id: doc.id });
        doc.base = result.base; doc.dirty = rawText(doc.input.value(), doc) !== doc.base; doc.conflict = false; this.compare = null;
        this.publish(doc); setShared("noodle.files.changed", { root: doc.root, sequence: Date.now() }); this.owner.refresh(cx, true);
      } catch (error) {
        this.compare = await call("document_conflict", { id: doc.id });
        doc.conflict = true; throw new Error(`${error.message || error} Compare the disk version, then save your merged result.`);
      }
    });
  }
  discard(cx) {
    const doc = this.current;
    this.job(cx, async () => {
      await this.flush(doc);
      const result = await call("document_discard", { id: doc.id });
      doc.base = result.base; doc.inputValue = result.base; doc.input.set_value(result.base); doc.dirty = false; doc.conflict = false; this.compare = null; this.confirmDiscard = false; this.publish(doc);
    });
  }
  accept(cx) {
    const doc = this.current;
    this.job(cx, async () => { const result = await call("document_accept_disk", { id: doc.id }); doc.base = result.base; doc.conflict = false; this.compare = null; });
  }
  requests(cx) {
    const event = shared("noodle.files.changed");
    if (event && this.event !== event.sequence) {
      const s = this.owner.selection;
      if (s?.file && event.root === s.root && (s.file.path === event.path || s.file.path.startsWith(event.path + "/"))) {
        if (event.operation === "trash") this.owner.openFile(null, null, cx, { kind: "file", hash: null, commit: null });
        else if (event.destination) this.owner.openFile({ ...s.file, path: event.destination + s.file.path.slice(event.path.length) }, null, cx, { kind: "file", hash: null, commit: null });
      }
      this.event = event.sequence;
      for (const doc of [...this.open.values()]) {
        if (event.root !== doc.root || !event.operation || !(doc.path === event.path || doc.path.startsWith(event.path + "/"))) continue;
        const next = event.destination ? event.destination + doc.path.slice(event.path.length) : doc.path;
        this.open.delete(doc.id);
        const owners = { ...(shared("noodle.documents") || {}) }; delete owners[doc.id]; setShared("noodle.documents", owners);
        if (this.current === doc) { this.current = null; this.owner.mode = "source"; }
        doc.closed = true; doc.input.release();
        if (event.operation !== "trash") this.owner.openFile({ path: next }, null, cx, { kind: "file", hash: null, commit: null });
        cx.notify();
      }
    }
    const request = shared("noodle.documents.request");
    if (!request && this.frozen) { this.frozen.release(); this.frozen = null; this.request = null;
      cx.spawn(async cx => { for (const doc of this.open.values()) { try { const fresh = await call("document_open", { root: doc.root, path: doc.path }); if (fresh.base === doc.inputValue) { doc.base = fresh.base; doc.dirty = rawText(doc.input.value(), doc) !== doc.base; this.publish(doc); } } catch (e) { this.error = e.message; } } cx.notify(); }); cx.notify(); }
    if (!request || request.id === this.request || this.busy) return;
    this.request = request.id;
    if (this.current) { this.frozen?.release(); this.frozen = EditorState.new({ value: this.current.input.value(), readonly: true, line_numbers: true, font_size: 13 }); cx.notify(); }
    cx.spawn(async cx => {
      try {
        for (const doc of this.open.values()) await this.flush(doc);
        const acks = shared(`noodle.documents.ack.${request.id}`) || {};
        setShared(`noodle.documents.ack.${request.id}`, { ...acks, [this.owner.selectionKey]: true });
      } catch (e) { this.error = e.message; cx.notify(); }
    });
  }
  async close() {
    for (const doc of this.open.values()) {
      if (doc.dirty) await this.flush(doc);
      const owners = { ...(shared("noodle.documents") || {}) };
      if (owners[doc.id]?.key === this.owner.selectionKey) { delete owners[doc.id]; setShared("noodle.documents", owners); }
    }
  }
  remove(doc, cx) {
    if (doc.dirty) { this.current = doc; this.confirmDiscard = true; this.error = "Save or discard this draft before closing the file."; cx.notify(); return; }
    doc.closed = true; doc.input.release(); this.open.delete(doc.id);
    const owners = { ...(shared("noodle.documents") || {}) }; delete owners[doc.id]; setShared("noodle.documents", owners);
    if (this.current === doc) { this.current = [...this.open.values()].at(-1) || null; if (!this.current) this.owner.selectMode("source", cx); }
    cx.notify();
  }
  notes(cx) {
    const doc = this.current;
    this.job(cx, async () => { const result = await call("document_note_prepare", { id: doc.id }); this.notePath = result.path; this.savedNotes = result.notes; this.tools = "notes"; });
  }
  saveNote(cx) {
    const doc = this.current;
    let range; try { range = this.range(); } catch (e) { this.error = e.message; cx.notify(); return; }
    this.job(cx, async () => { await writeTextFile(this.notePath, this.note.value(), ""); const result = await call("document_note_save", { id: doc.id, range, commit: doc.selection.hash || null }); this.savedNotes = result.notes; this.note.set_value(""); const next = await call("document_note_prepare", { id: doc.id }); this.notePath = next.path; });
  }
  range() {
    const doc = this.current;
    if (typeof doc?.input.selected_range !== "function") throw new Error("Selection tools need the native editor API update; see native/README.md");
    return doc.input.selected_range();
  }
  copy(cx, textOnly = false, includeText = false) {
    try {
      const doc = this.current, range = this.range(), value = doc.input.value();
      const start = range.start ?? range[0] ?? 0, end = range.end ?? range[1] ?? start;
      const line = value.slice(0, start).split('\n').length, last = value.slice(0, end).split('\n').length;
      const ref = `${doc.path}:${line}${last !== line ? `-${last}` : ""}`;
      cx.write_to_clipboard(textOnly ? value.slice(start, end) : includeText ? `${ref}\n${value.slice(start, end)}` : ref);
    } catch (e) { this.error = e.message; cx.notify(); }
  }
  seek(cx) {
    try {
      const doc = this.current;
      if (typeof doc.input.set_selected_range !== "function") throw new Error("Line navigation needs the native editor API update; see native/README.md");
      const line = Number(this.line.value()); if (!Number.isInteger(line) || line < 1) throw new Error("Enter a positive line number");
      const lines = doc.input.value().split('\n'); if (line > lines.length) throw new Error(`This file has ${lines.length} lines`);
      const start = lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0);
      doc.input.set_selected_range({ start, end: start }); this.tools = null; cx.notify();
    } catch (e) { this.error = e.message; cx.notify(); }
  }
  render(t, cx) {
    const doc = this.current;
    if (!doc) return div().flex_1().p(16).child(this.error || "Opening editor…");
    const nativeSelection = typeof doc.input.selected_range === "function" && typeof doc.input.set_selected_range === "function";
    const button = (id, label, fn, disabled = this.busy || Boolean(this.frozen)) => Button.new(id).h(28).px(8).rounded(5).text_size(12).child(label).disabled(disabled).on_click((_e, cx) => fn(cx));
    return v_flex().flex_1().min_h(0).key_context("NoodleEditor").on_action("noodle.save", (_e, cx) => { this.save(cx); cx.stop_propagation(); }).on_key_down((e, cx) => { if (e.keystroke === "ctrl-g") { this.tools = "line"; cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().overflow_x_scrollbar()
        .children([...this.open.values()].map(d => button(`open-${d.id}`, `${d.dirty ? "• " : ""}${d.path}`, cx => { this.current = d; this.owner.openFile(d.selection.file, null, cx, d.selection); this.owner.mode = "edit"; }))))
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar()
        .child(button("save-file", "Save", cx => this.save(cx), this.busy || !doc.dirty || doc.conflict))
        .child(button("close-open-file", "Close file", cx => this.remove(doc, cx)))
        .child(button("save-file-as", "Save as…", cx => { this.saveAs = !this.saveAs; cx.notify(); }))
        .child(button("discard-draft", "Discard…", cx => { this.confirmDiscard = true; cx.notify(); }, !doc.dirty || this.busy))
        .child(button("find-file", "Find / Replace", cx => { if (typeof doc.input.open_search === "function") doc.input.open_search(true); else { this.error = "Native find/replace needs the editor API update; see native/README.md"; cx.notify(); } }, this.busy || typeof doc.input.open_search !== "function"))
        .child(button("goto-line", "Go to line", cx => { this.tools = this.tools === "line" ? null : "line"; cx.notify(); }, !nativeSelection || this.busy))
        .child(button("copy-reference", "Copy reference", cx => this.copy(cx), !nativeSelection || this.busy))
        .child(button("copy-selection", "Copy text", cx => this.copy(cx, true), !nativeSelection || this.busy))
        .child(button("file-notes", "Notes", cx => this.notes(cx), !nativeSelection || this.busy))
        .child(button("copy-for-agent", "Copy for agent", cx => this.copy(cx, false, true), !nativeSelection || this.busy)))
      .when(this.saveAs, el => el.child(h_flex().px(12).py(8).gap(8).child(Input.new(this.destination).flex_1()).child(button("confirm-save-as", "Save as", cx => this.save(cx, true)))))
      .when(this.tools === "line", el => el.child(h_flex().px(12).py(8).gap(8).child(Input.new(this.line).flex_1()).child(button("reveal-line", "Go", cx => this.seek(cx)))))
      .when(this.tools === "notes", el => el.child(v_flex().px(16).py(12).gap(8).child(Input.new(this.note))
        .child(h_flex().gap(8).child(button("save-file-note", "Save note at selection", cx => this.saveNote(cx))).child(button("close-file-notes", "Close", cx => { this.tools = null; cx.notify(); })))
        .children((this.savedNotes || []).map((n, i) => h_flex().gap(8).items_center().child(div().flex_1().child(n.text)).child(button(`copy-note-${i}`, "Copy for agent", cx => cx.write_to_clipboard(`${doc.path} · selection ${n.range?.start || 0}-${n.range?.end || 0}\n${n.text}`)))))))
      .when(this.confirmDiscard, el => el.child(h_flex().px(12).py(8).gap(8).child(div().flex_1().child("Discard this draft and reload the saved file?"))
        .child(button("cancel-discard", "Cancel", cx => { this.confirmDiscard = false; cx.notify(); })).child(button("confirm-discard", "Discard draft", cx => this.discard(cx)))))
      .when(Boolean(this.error), el => el.child(div().px(16).py(8).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.compare), el => el.child(v_flex().max_h(200).id("disk-conflict").overflow_y_scrollbar().px(16).py(12).gap(8).bg(t.background)
        .child(div().font_semibold().child("The saved file changed. Merge these changes into your draft below."))
        .child(div().font_family(settings().font_family || "JetBrains Mono").child(this.compare.disk))
        .child(button("accept-disk-base", "I reviewed this disk version · enable Save", cx => this.accept(cx)))))
      .child(Editor.new(this.frozen || doc.input).flex_1().min_h(0))
      .child(div().h(28).flex_none().px(16).text_size(11).text_color(t.muted).child(this.busy ? "Saving…" : !nativeSelection ? `${doc.dirty ? "Unsaved changes · recovery draft kept locally" : "Saved"} · selection tools need the editor update` : doc.dirty ? "Unsaved changes · recovery draft kept locally" : "Saved"));
  }
}
