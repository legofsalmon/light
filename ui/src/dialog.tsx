// In-app modal dialogs. The packaged app runs in WKWebView, which implements
// NONE of window.alert/confirm/prompt — they return false/null with no UI at
// all, so every confirm-guarded action silently no-opped in the release build
// (and an .mvr import silently took the destructive branch). These promise-
// based dialogs work identically in the app and in a LAN browser.

import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

export type DialogChoice = { value: string; label: string; danger?: boolean; primary?: boolean };

type DialogRequest = {
  id: number;
  title: string;
  body?: string;
  /** present = prompt */
  input?: { initial: string; placeholder?: string };
  choices: DialogChoice[];
  resolve: (value: string | null) => void;
};

type DialogStore = {
  queue: DialogRequest[];
  push: (r: Omit<DialogRequest, 'id'>) => void;
  settle: (id: number, value: string | null) => void;
};

let seq = 0;

const useDialogs = create<DialogStore>()((set, get) => ({
  queue: [],
  push: (r) => set((s) => ({ queue: [...s.queue, { ...r, id: ++seq }] })),
  settle: (id, value) => {
    const req = get().queue.find((q) => q.id === id);
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    req?.resolve(value);
  },
}));

/** Yes/no question. Resolves true only on the confirming choice. */
export function askConfirm(
  title: string,
  opts: { body?: string; confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      title,
      body: opts.body,
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'ok', label: opts.confirmLabel ?? 'OK', primary: !opts.danger, danger: opts.danger },
      ],
      resolve: (v) => resolve(v === 'ok'),
    });
  });
}

/** Text question. Resolves the trimmed string, or null if dismissed/empty. */
export function askPrompt(
  title: string,
  initial = '',
  opts: { body?: string; placeholder?: string; confirmLabel?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      title,
      body: opts.body,
      input: { initial, placeholder: opts.placeholder },
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'ok', label: opts.confirmLabel ?? 'OK', primary: true },
      ],
      resolve: (v) => resolve(v === null || v === 'cancel' ? null : v),
    });
  });
}

/** Multi-way question — e.g. merge / replace / cancel. Resolves the chosen
 *  value, or null when dismissed; no destructive default hides behind Esc. */
export function askChoice(
  title: string,
  choices: DialogChoice[],
  opts: { body?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().push({
      title,
      body: opts.body,
      choices: [...choices, { value: 'cancel', label: 'Cancel' }],
      resolve: (v) => resolve(v === 'cancel' ? null : v),
    });
  });
}

/** Renders the head of the dialog queue. Mounted once, next to the app. */
export function DialogHost() {
  const queue = useDialogs((s) => s.queue);
  const settle = useDialogs((s) => s.settle);
  const req = queue[0];
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const id = req?.id;

  useEffect(() => {
    if (!req) return;
    setText(req.input?.initial ?? '');
    // focus after paint so the caret lands in the field, not on the button
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [id, req]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      // dismissal is never destructive: Esc always cancels
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settle(req.id, null);
      }
    };
    // capture: the app's global hotkeys must not see keys aimed at the dialog
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, settle]);

  if (!req) return null;
  const answer = (value: string) => settle(req.id, req.input ? (value === 'ok' ? text.trim() || null : null) : value);

  return (
    <div
      className="modalveil"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) settle(req.id, null);
      }}
    >
      <div className="modal panel" role="dialog" aria-modal="true" aria-label={req.title}>
        <div className="modaltitle">{req.title}</div>
        {req.body && <div className="modalbody">{req.body}</div>}
        {req.input && (
          <input
            ref={inputRef}
            className="text"
            style={{ width: '100%', marginTop: 10 }}
            placeholder={req.input.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                answer('ok');
              }
            }}
          />
        )}
        <div className="modalrow">
          {req.choices.map((c) => (
            <button
              key={c.value}
              className={`btn small ${c.primary ? 'on' : ''} ${c.danger ? 'danger' : 'ghost'}`}
              onClick={() => answer(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
