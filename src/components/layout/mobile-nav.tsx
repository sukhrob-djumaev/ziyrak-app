"use client";

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
