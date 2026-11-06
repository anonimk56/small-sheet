import Workspace from "@/components/Workspace";

// A layout is NOT re-created when you move between /sheets/budget and
// /sheets/big, so everything inside it (loaded sheets, undo history,
// pending saves) survives switching tabs.
export default function SheetsLayout({ children }: { children: React.ReactNode }) {
  return <Workspace>{children}</Workspace>;
}