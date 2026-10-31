import { create } from 'zustand';
import { api } from './api';
import type { Lang, Me, Preferences } from './types';

const LANG_KEY = 'pdl.lang';
function cachedLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === 'en' || v === 'vi') return v;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('vi') ? 'vi' : 'en';
}

interface AppState {
  me: Me | null;
  loaded: boolean;
  lang: Lang;
  load: () => Promise<void>;
  setMe: (me: Me | null) => void;
  setLang: (lang: Lang) => Promise<void>;
  updatePrefs: (p: Partial<Preferences>) => Promise<void>;
  logout: () => Promise<void>;
}

/** The server is the source of truth for preferences; localStorage only caches the UI language. */
export const useApp = create<AppState>((set, get) => ({
  me: null,
  loaded: false,
  lang: cachedLang(),
  load: async () => {
    try {
      const me = await api.get<Me>('/auth/me');
      get().setMe(me);
    } catch {
      set({ me: null });
    } finally {
      set({ loaded: true });
    }
  },
  setMe: (me) => {
    set({ me });
    if (me) {
      set({ lang: me.preferences.language });
      try {
        localStorage.setItem(LANG_KEY, me.preferences.language);
      } catch {
        /* ignore */
      }
    }
  },
  setLang: async (lang) => {
    set({ lang });
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore */
    }
    if (get().me) await get().updatePrefs({ language: lang });
  },
  updatePrefs: async (p) => {
    const me = await api.put<Me>('/preferences', p);
    set({ me });
  },
  logout: async () => {
    await api.post('/auth/logout');
    set({ me: null });
  },
}));
