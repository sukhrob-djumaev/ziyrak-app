"use client";

import { Menu } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";

interface MobileNav {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const MobileNavContext = createContext<MobileNav>({ open: false, setOpen: () => undefined });

/** Open/closed state of the phone-width navigation drawer, shared by the header button and the sidebar. */
export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>;
}

export const useMobileNav = () => useContext(MobileNavContext);

/** Phone-width bar with the menu button, shown on every dashboard page (the sidebar is hidden below md). */
export function MobileMenuBar() {
  const { open, setOpen } = useMobileNav();
  return (
    <div className="md:hidden flex items-center gap-2 px-3 py-2 bg-ziyrak-sidebar text-white">
      <button
        id="open-menu"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="p-2 rounded-md hover:bg-ziyrak-sidebar-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <span className="text-sm font-semibold">Ziyrak</span>
    </div>
  );
}
