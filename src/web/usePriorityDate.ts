import { useEffect, useState } from 'react';
import { localCalendarDate } from '../shared/notePriority.js';

export function usePriorityDate(): string {
  const [date, setDate] = useState(localCalendarDate);
  useEffect(() => {
    let timer: number;
    function refresh() {
      const now = new Date();
      setDate(localCalendarDate(now));
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, midnight.getTime() - now.getTime());
    }
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return date;
}
