"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ThemeStore {
  theme: "light" | "dark";
  toggleTheme: () => void;
  setTheme: (theme: "light" | "dark") => void;
}

const LEGACY_THEME_KEY = "owly-theme";

/** One-time move of the pre-rename preference so nobody loses their saved theme. */
function migrateLegacyTheme() {
  try {
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy !== null && localStorage.getItem("ziyrak-theme") === null) {
      localStorage.setItem("ziyrak-theme", legacy);
    }
    if (legacy !== null) localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // storage unavailable: keep the default theme
  }
}
if (typeof window !== "undefined") migrateLegacyTheme();

export const useTheme = create<ThemeStore>()(
  persist(
    (set) => ({
      theme: "light",
      toggleTheme: () =>
        set((state) => {
          const newTheme = state.theme === "light" ? "dark" : "light";
          if (typeof document !== "undefined") {
            document.documentElement.classList.toggle("dark", newTheme === "dark");
          }
          return { theme: newTheme };
        }),
      setTheme: (theme) => {
        if (typeof document !== "undefined") {
          document.documentElement.classList.toggle("dark", theme === "dark");
        }
        set({ theme });
      },
    }),
    {
      name: "ziyrak-theme",
      onRehydrateStorage: () => (state) => {
        if (state?.theme === "dark" && typeof document !== "undefined") {
          document.documentElement.classList.add("dark");
        }
      },
    }
  )
);
