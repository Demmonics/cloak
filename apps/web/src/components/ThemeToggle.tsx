import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'color-scheme';

function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'system' || raw === 'light') {
      return raw;
    }
  } catch {
    // Ignore storage access errors in restricted contexts.
  }
  // Muted stone/sage Light mode is Cloak's signature default unless overridden.
  return 'light';
}

function applyThemePreference(pref: ThemePreference): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = pref === 'system' ? 'light dark' : pref;
  }
  try {
    if (pref === 'light') {
      window.localStorage.setItem(STORAGE_KEY, 'light');
    } else {
      window.localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    // Ignore storage access errors.
  }
}

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredPreference());
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);

  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const onMediaChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        const next = readStoredPreference();
        setPreference(next);
        const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
        if (meta) {
          meta.content = next === 'system' ? 'light dark' : next;
        }
      }
    };
    mq?.addEventListener('change', onMediaChange);
    window.addEventListener('storage', onStorage);
    return () => {
      mq?.removeEventListener('change', onMediaChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const options: Array<{
    value: ThemePreference;
    label: string;
    title: string;
    icon: typeof Sun;
  }> = [
    {
      value: 'light',
      label: 'Stone',
      title: 'Signature Muted Stone & Sage Light theme',
      icon: Sun,
    },
    {
      value: 'system',
      label: 'Auto',
      title: `Match system theme (currently ${systemDark ? 'Deep Forest' : 'Stone'})`,
      icon: Monitor,
    },
    {
      value: 'dark',
      label: 'Forest',
      title: 'Deep Forest Dark theme',
      icon: Moon,
    },
  ];

  return (
    <div
      role="group"
      aria-label="Color theme"
      data-testid="theme-toggle"
      className="inline-flex items-center rounded-full border border-[var(--cloak-border)] bg-[var(--cloak-bg-elevated)] p-0.5 shadow-2xs"
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = preference === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setPreference(opt.value)}
            aria-pressed={active}
            title={opt.title}
            data-testid={`theme-${opt.value}-btn`}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium cursor-pointer transition-colors ${
              active
                ? 'bg-[var(--cloak-accent)] text-[var(--cloak-accent-ink)] shadow-2xs'
                : 'text-[var(--cloak-text-muted)] hover:text-[var(--cloak-text)] hover:bg-[var(--cloak-bg-hover)]'
            }`}
          >
            <Icon className="w-3 h-3 shrink-0" />
            <span className="hidden md:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
