import { redirect } from "next/navigation";

// "/" has nothing of its own: send everyone to the first sheet.
export default function Home() {
  redirect("/sheets/budget");
}