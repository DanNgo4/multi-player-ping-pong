import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ping Pong Live",
  description: "Realtime multiplayer ping pong with live spectating",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
