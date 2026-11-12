import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';

/**
 * Lightweight typed React subscription over Dexie's native liveQuery observable.
 */
export function useDexieLiveQuery<T>(
  querier: () => Promise<T>,
  deps: readonly unknown[],
  defaultValue: T,
): T {
  const [value, setValue] = useState<T>(defaultValue);

  useEffect(() => {
    const sub = liveQuery(querier).subscribe({
      next: (nextVal) => setValue(nextVal),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}

