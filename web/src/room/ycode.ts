import * as Y from 'yjs';

export const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Minimal Monaco <-> Yjs binding (no monaco-editor import: works with the editor instance @monaco-editor/react gives us).
 *  Local edits become Y.Text operations; remote Y.Text changes become model edits, so cursors of other people's typing are preserved by Monaco. */
export function bindYText(editor: any, opts: {
  file: string; subscribe: (fn: (m: any) => void) => () => void; sendUpdate: (b64: string) => void; requestSync: () => void;
  onText: (text: string) => void; onReady: (ready: boolean) => void;
}) {
  const model = editor.getModel(); if (!model) return () => {};
  const doc = new Y.Doc(); const text = doc.getText('c'); let applying = false; let ready = false;
  model.setEOL(0); // LF, so Monaco offsets equal Y.Text offsets
  applying = true; model.setValue(''); applying = false;
  opts.onReady(false);

  const sub = editor.onDidChangeModelContent((e: any) => {
    if (applying) return;
    if (!ready) return; // editor is read-only until the initial sync arrives
    doc.transact(() => {
      // Monaco reports offsets against the pre-change model; apply right-to-left so earlier offsets stay valid.
      for (const c of [...e.changes].sort((a: any, b: any) => b.rangeOffset - a.rangeOffset)) {
        if (c.rangeLength) text.delete(c.rangeOffset, c.rangeLength);
        if (c.text) text.insert(c.rangeOffset, c.text);
      }
    }, 'local');
    opts.onText(text.toString());
  });

  text.observe((ev: Y.YTextEvent) => {
    if (ev.transaction.origin === 'local') return;
    applying = true;
    try {
      let index = 0;
      for (const op of ev.delta) {
        if (op.retain !== undefined) index += op.retain;
        else if (op.insert !== undefined) {
          const s = String(op.insert); const pos = model.getPositionAt(index);
          model.applyEdits([{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: s, forceMoveMarkers: true }]);
          index += s.length;
        } else if (op.delete !== undefined) {
          const a = model.getPositionAt(index), b = model.getPositionAt(index + op.delete);
          model.applyEdits([{ range: { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column }, text: '' }]);
        }
      }
    } finally { applying = false; }
    opts.onText(text.toString());
  });

  doc.on('update', (u: Uint8Array, origin: any) => { if (origin === 'remote') return; opts.sendUpdate(toB64(u)); });

  const unsub = opts.subscribe(m => {
    if (m.file !== opts.file) return;
    Y.applyUpdate(doc, fromB64(m.update), 'remote');
    if (m.sync && !ready) { ready = true; opts.onReady(true); }
  });
  opts.requestSync();

  return () => { sub.dispose(); unsub(); doc.destroy(); };
}
