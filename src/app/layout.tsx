import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { Geist } from "next/font/google";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { LinkProvider } from "@astryxdesign/core/Link";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Loop Studio",
  description: "설문을 설계하고 검토하고 미리 보고 합성 응답으로 시뮬레이션하는 로컬 도구",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" data-theme="light" className={cn("font-sans", geist.variable)}>
      <body>
        <Theme theme={neutralTheme} mode="light">
          <LinkProvider component={Link}>{children}</LinkProvider>
        </Theme>
      </body>
    </html>
  );
}
