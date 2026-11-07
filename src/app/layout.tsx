import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Small Sheet",
  description: "A small spreadsheet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}