import { useCallback, useEffect, useRef, useState } from 'react';

export const BOARD_NOTICE_DURATION = 4400;

export function useBoardNotice() {
  const [entry, setEntry] = useState({ text: '', key: 0, transient: false });
  const sequence = useRef(0);
  const setNotice = useCallback((text: string) => setEntry({ text, key: ++sequence.current, transient: false }), []);
  const flashNotice = useCallback((text: string) => setEntry({ text, key: ++sequence.current, transient: true }), []);
  useEffect(() => {
    if (!entry.transient) return;
    const timer = window.setTimeout(() => {
      setEntry(current => current.key === entry.key ? { ...current, text: '', transient: false } : current);
    }, BOARD_NOTICE_DURATION);
    return () => window.clearTimeout(timer);
  }, [entry.key, entry.transient]);
  return { notice: entry.text, noticeKey: entry.key, transient: entry.transient, setNotice, flashNotice };
}
