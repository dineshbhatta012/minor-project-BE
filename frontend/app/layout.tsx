import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kathmandu Bus Route Finder",
  description: "Find direct and single-transfer bus routes across Kathmandu Valley",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
