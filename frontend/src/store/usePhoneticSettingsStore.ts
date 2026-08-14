import { create } from 'zustand';
import {
  getPhoneticRules, putPhoneticRules, getPhoneticStyles, putPhoneticStyle,
} from '../api/client';
import {
  DEFAULT_PHONETIC_RULES, ruleListKey, type PhoneticRule,
} from '../components/phonetics/rules';
import { defaultBoStyle, type BoStyle } from '../components/phonetics/generate';

/**
 * The organization's phonetics settings: the replacement rules applied to every generated
 * string, and the style each booklet language opens on.
 *
 * Both work the same way — a built-in FLOOR in code, overridden by whatever the org has
 * stored (the arrangement `ORG_BASE` uses for styles). Absent means "never said", not
 * "empty": that is what lets the floor speak. Saving replaces it, including saving an empty
 * rule list, which is how an org says "none of those, thank you".
 *
 * Shared by the bench and by the popup that edits the rules, so a save takes effect on the
 * very next generation without a reload.
 */
interface PhoneticSettingsState {
  lists: Record<string, PhoneticRule[]>;
  /** lang → the style that language opens on, where the org has chosen one. */
  styles: Record<string, BoStyle>;
  loaded: boolean;
  error: string | null;
  fetchSettings: () => Promise<void>;
  saveList: (kind: 'bo' | 'skt', lang: string, rules: PhoneticRule[]) => Promise<void>;
  saveStyle: (lang: string, style: BoStyle) => Promise<void>;
}

export const usePhoneticSettingsStore = create<PhoneticSettingsState>((set) => ({
  lists: {},
  styles: {},
  loaded: false,
  error: null,

  fetchSettings: async () => {
    try {
      const [ruleRows, styleRows] = await Promise.all([getPhoneticRules(), getPhoneticStyles()]);
      const lists: Record<string, PhoneticRule[]> = {};
      for (const r of ruleRows) lists[ruleListKey(r.kind, r.lang)] = r.rules;
      const styles: Record<string, BoStyle> = {};
      for (const s of styleRows) styles[s.lang] = s.style as BoStyle;
      set({ lists, styles, loaded: true, error: null });
    } catch (e: any) {
      // Never block the bench on this: no settings is a worse day, not a broken bench.
      set({ loaded: true, error: e.message || 'Could not load the phonetics settings' });
    }
  },

  saveList: async (kind, lang, rules) => {
    const saved = await putPhoneticRules({ kind, lang, rules });
    set(s => ({
      lists: { ...s.lists, [ruleListKey(kind, lang)]: saved.rules },
      error: null,
    }));
  },

  saveStyle: async (lang, style) => {
    const saved = await putPhoneticStyle({ lang, style });
    set(s => ({
      styles: { ...s.styles, [saved.lang]: saved.style as BoStyle },
      error: null,
    }));
  },
}));

/** The rules to apply for one (kind, language): what the org stored, else the built-in floor. */
export function rulesFor(
  lists: Record<string, PhoneticRule[]>, kind: string, lang: string,
): PhoneticRule[] {
  return lists[ruleListKey(kind, lang)] ?? DEFAULT_PHONETIC_RULES[ruleListKey(kind, lang)] ?? [];
}

/** The style a language opens on: the org's choice, else the built-in default. */
export function styleFor(styles: Record<string, BoStyle>, lang: string): BoStyle {
  return styles[lang] ?? defaultBoStyle(lang);
}
