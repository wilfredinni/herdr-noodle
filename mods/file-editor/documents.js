import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, Button } from "gpui-base";
import { exec, appHome, writeTextFile, settings, shared, setShared, panes, run, theme } from "herdr";
import { lineChanges } from "./gutter.js";

async function call(action, request) {
  const r = await exec("python3", [`${appHome()}/helpers/noodle/workspace.py`, action, JSON.stringify({ home: appHome(), ...request })]);
  let data; try { data = JSON.parse(r.stdout); } catch { throw new Error(r.stderr || "The workspace helper is unavailable"); }
  if (r.code || data.error) throw new Error(data.error || r.stderr);
  return data;
}
const language = path => {
  const name = path.split('/').pop().toLowerCase(), extension = name.split('.').pop();
  return ({ dockerfile: "dockerfile", makefile: "make" })[name] || ({ js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", md: "markdown", rs: "rust", yml: "yaml", sh: "bash", zsh: "bash" })[extension] || extension;
};
export const rawText = (value, doc) => doc.normalizedCRLF ? value.replace(/\r?\n/g, '\r\n') : value;
const sameSelection = (a, b) => a?.root === b?.root && a?.on === b?.on && a?.file?.path === b?.file?.path && a?.hash === b?.hash && a?.kind === b?.kind && a?.editRequest === b?.editRequest;

export class Documents {
  constructor(owner, cx) {
    this.owner = owner; this.open = new Map();
    cx.bind_keys?.(["cmd-s", "ctrl-s"].map(keystroke => ({ keystroke, action: "noodle.save", context: "NoodleEditor" })));
    cx.timer.every(500, cx => this.requests(cx));
  }
  job(cx, task) {
    if (this.busy) return;
    this.busy = true; this.error = null;
    cx.spawn(async cx => { try { await task(cx); } catch (e) { this.error = String(e.message || e); } finally {
      this.busy = false;
      const pending = this.pendingEdit; this.pendingEdit = null;
      if (pending && sameSelection(pending, this.owner.selection) && this.owner.mode === "source") this.edit(cx);
      cx.notify();
    } }); cx.notify();
  }
  edit(cx) {
    const s = this.owner.selection;
    if (!s?.file || s.on || s.hash || s.diffMode === "staged" || s.file.status === "D") return;
    const existing = [...this.open.values()].find(d => (d.selection.root === s.root || d.root === s.root) && d.path === s.file.path);
    if (this.current !== existing) { this.compare = null; this.confirmDiscard = false; this.error = null; }
    if (existing) { this.current = existing; this.owner.mode = "source"; this.checkpoint(existing, cx); cx.notify(); return; }
    this.current = null; this.owner.mode = "source";
    if (this.busy) { this.pendingEdit = s; cx.notify(); return; }
    this.job(cx, async cx => {
      const data = await call("document_open", { root: s.root, path: s.file.path });
      if (!sameSelection(s, this.owner.selection) || this.owner.mode !== "source") return;
      const owners = shared("noodle.documents") || {}, other = owners[data.id];
      if (other && other.key !== this.owner.selectionKey && panes().some(p => p.pane === other.pane)) {
        run("pane.focus", { pane: other.pane }); return;
      }
      let doc = this.open.get(data.id);
      if (!doc) {
        if (this.open.size >= 20) throw new Error("Close and reopen this editor pane to open more files. Recovery drafts are kept locally.");
        const input = EditorState.new({ value: data.draft, language: language(data.path), line_numbers: true, folding: true, soft_wrap: false, font_family: settings().font_family || "JetBrains Mono", font_size: 13 });
        doc = { ...data, input, selection: { ...s, hash: null, parent: null, commit: null, diffMode: null, kind: "file" }, dirty: data.dirty };
        // Some native editor versions normalize CRLF on input. Restore that convention on save.
        doc.normalizedCRLF = data.draft.includes('\r\n') && input.value() === data.draft.replaceAll('\r\n', '\n');
        if (input.value() !== data.draft && !doc.normalizedCRLF) { input.release(); throw new Error("This Herdr editor changes the original text. Editing was cancelled."); }
        this.open.set(doc.id, doc);
        input.on("change", (_e, cx) => {
          const wasDirty = doc.dirty;
          doc.dirty = rawText(input.value(), doc) !== doc.base; doc.change = (doc.change || 0) + 1;
          const change = doc.change; this.publish(doc);
          cx.timer.after(200, cx => { if (change === doc.change) this.checkpoint(doc, cx); });
          if (wasDirty !== doc.dirty) cx.notify();
        });
      }
      this.current = doc; this.owner.mode = "source";
      this.publish(doc); cx.notify();
      await this.refreshGutter(doc);
    });
  }
  publish(doc) {
    const owners = shared("noodle.documents") || {}, previous = owners[doc.id];
    if (previous?.key === this.owner.selectionKey && previous.root === doc.root && previous.path === doc.path && previous.dirty === doc.dirty) return;
    const pane = panes().find(p => p.mod === "file-editor" && p.props?.selectionKey === this.owner.selectionKey) || panes().find(p => p.mod === "file-editor" && `file-editor.${p.tab}` === this.owner.selectionKey);
    setShared("noodle.documents", { ...owners, [doc.id]: { key: this.owner.selectionKey, pane: pane?.pane, root: doc.root, path: doc.path, dirty: doc.dirty } });
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
    cx.spawn(async cx => { try { await this.flush(doc); await this.refreshGutter(doc); } catch (e) { this.error = `Draft recovery or gutter update failed: ${e.message || e}`; cx.notify(); } });
  }
  async refreshGutter(doc) {
    if (typeof doc.input.set_gutter_marks !== "function") return;
    const change = doc.change || 0;
    const result = await call("document_gutter", { id: doc.id });
    if (doc.closed || change !== (doc.change || 0) || result.revision !== doc.revision) return;
    doc.gutterMarks = [...lineChanges(result.hunks, result.lineCount)].map(([line, mark]) => ({ line, ...mark }));
    this.applyGutter(doc, theme());
  }
  applyGutter(doc, t) {
    if (!doc.gutterMarks) return;
    const palette = `${t.ansi1},${t.ansi2},${t.ansi3}`;
    if (doc.appliedMarks === doc.gutterMarks && doc.gutterPalette === palette) return;
    doc.input.set_gutter_marks(doc.gutterMarks.map(mark => ({ line: mark.line,
      ...(mark.change ? { color: mark.change === "added" ? t.ansi2 : t.ansi3 } : {}),
      ...(mark.deletedBefore ? { deleted_before: t.ansi1 } : {}),
      ...(mark.deletedAfter ? { deleted_after: t.ansi1 } : {})
    })));
    doc.appliedMarks = doc.gutterMarks; doc.gutterPalette = palette;
  }
  save(cx) {
    const doc = this.current; if (!doc || this.frozen) return;
    this.job(cx, async cx => {
      await this.flush(doc);
      try {
        await writeTextFile(doc.absolute, doc.inputValue, doc.base);
        const result = await call("document_saved", { id: doc.id });
        doc.base = result.base; doc.revision = result.revision; doc.dirty = rawText(doc.input.value(), doc) !== doc.base; doc.conflict = false; this.compare = null;
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
      doc.base = result.base; doc.revision = result.revision; doc.inputValue = result.base; doc.input.set_value(result.base); doc.dirty = false; doc.conflict = false; this.compare = null; this.confirmDiscard = false; this.publish(doc); await this.refreshGutter(doc);
    });
  }
  accept(cx) {
    const doc = this.current;
    this.job(cx, async () => { const result = await call("document_accept_disk", { id: doc.id }); doc.base = result.base; doc.revision = result.revision; doc.conflict = false; this.compare = null; });
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
    if (doc.dirty) {
      this.current = doc; this.compare = null; this.owner.openFile(doc.selection.file, null, cx, doc.selection);
      this.confirmDiscard = true; this.error = "Save or discard this draft before closing the file."; cx.notify(); return;
    }
    doc.closed = true; doc.input.release(); this.open.delete(doc.id);
    const owners = { ...(shared("noodle.documents") || {}) }; delete owners[doc.id]; setShared("noodle.documents", owners);
    if (this.current === doc) {
      this.current = [...this.open.values()].at(-1) || null;
      if (this.current) this.owner.openFile(this.current.selection.file, null, cx, this.current.selection);
      else this.owner.selectFile(cx);
    }
    cx.notify();
  }
  render(t, cx) {
    const doc = this.current;
    if (!doc) return div().flex_1().p(16).child(this.error || "Opening editor…");
    this.applyGutter(doc, t);
    const button = (id, label, fn, disabled = this.busy || Boolean(this.frozen)) => Button.new(id).h(28).px(8).rounded(5).text_size(12).child(label).disabled(disabled).on_click((_e, cx) => fn(cx));
    return v_flex().flex_1().min_h(0).key_context("NoodleEditor").on_action("noodle.save", (_e, cx) => { this.save(cx); cx.stop_propagation(); })
      .when(this.confirmDiscard, el => el.child(h_flex().px(12).py(8).gap(8).child(div().flex_1().child("Discard this draft and reload the saved file?"))
        .child(button("cancel-discard", "Cancel", cx => { this.confirmDiscard = false; cx.notify(); })).child(button("confirm-discard", "Discard draft", cx => this.discard(cx)))))
      .when(Boolean(this.error), el => el.child(div().px(16).py(8).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.compare), el => el.child(v_flex().max_h(200).id("disk-conflict").overflow_y_scrollbar().px(16).py(12).gap(8).bg(t.background)
        .child(div().font_semibold().child("The saved file changed. Merge these changes into your draft below."))
        .child(div().font_family(settings().font_family || "JetBrains Mono").child(this.compare.disk))
        .child(button("accept-disk-base", "I reviewed this disk version · enable Save", cx => this.accept(cx)))))
      .child(Editor.new(this.frozen || doc.input).flex_1().min_h(0))
      .child(div().h(28).flex_none().px(16).text_size(11).text_color(t.muted).child(this.busy ? "Saving…" : `${doc.dirty ? "Unsaved changes" : "Saved"} · ⌘S / Ctrl+S to save`));
  }
}
