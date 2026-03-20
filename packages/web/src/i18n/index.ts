import en from "./locales/en";
import type { LocaleKeys } from "./locales/en";
import zhCN from "./locales/zh-CN";
import { useUIStore } from "../stores/uiStore";

export type Locale = "en" | "zh-CN";

const messages: Record<Locale, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

export const ALL_LOCALES: Locale[] = ["en", "zh-CN"];

/**
 * Translation function — returns the translated string for the current locale.
 * Falls back to English if the key is missing in the current locale.
 */
function translate(locale: Locale, key: LocaleKeys): string {
  return messages[locale]?.[key] ?? messages.en[key] ?? key;
}

/**
 * React hook that returns a `t()` function bound to the current locale.
 * Usage: `const t = useI18n();` then `t("login.title")`
 */
export function useI18n() {
  const locale = useUIStore((s) => s.locale);
  return (key: LocaleKeys) => translate(locale, key);
}

export type { LocaleKeys };
