import SheetView from "@/components/SheetView";

// Temporary: /?fixture=budget (default), big, broken. Anything else shows
// the "not found" screen. Step 11 replaces this with /sheets/[id] routes.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ fixture?: string }>;
}) {
  const { fixture } = await searchParams;
  const id = typeof fixture === "string" && fixture !== "" ? fixture : "budget";

  return (
    <main>
      {/* key: switching sheets gives a fresh view instead of reusing old state */}
      <SheetView key={id} id={id} />
    </main>
  );
}