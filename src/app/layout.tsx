import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kinetics - Playable Video MVP",
  description: "Interactive educational video powered by MediaPipe in the browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
