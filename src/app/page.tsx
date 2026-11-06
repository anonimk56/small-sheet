import Grid from "@/components/Grid";
import { getFixture, isFixtureName } from "@/lib/fixtures";

// Temporary, until sheets are loaded from the API in step 10:
// /?fixture=budget (default), /?fixture=big or /?fixture=broken
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ fixture?: string }>;
}) {
  const { fixture } = await searchParams;
  const name = isFixtureName(fixture) ? fixture : "budget";

  return (
    <main>
      {/* key: a different fixture gets a fresh Grid instead of reusing old state */}
      <Grid key={name} initialCells={getFixture(name)} />
    </main>
  );
}