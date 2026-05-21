import type { Metadata } from "next";
import { JetBrains_Mono, Inter, Outfit } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import { AuthProvider } from "@/components/AuthProvider";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-display", weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "OtakuBox — Watch Anime",
  description: "Stream anime free. Sub & dub, no ads, no sign-up.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${jetbrains.variable} ${outfit.variable} min-h-screen antialiased font-sans`}>
        <AuthProvider>
          <Navbar />
          <main className="min-h-[calc(100vh-52px)]">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
