"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "대시보드",
    isActive: (p: string) => p === "/dashboard" || p.startsWith("/surveys"),
  },
  { href: "/templates", label: "템플릿", isActive: (p: string) => p.startsWith("/templates") },
  { href: "/constructs", label: "구성 개념", isActive: (p: string) => p.startsWith("/constructs") },
  { href: "/settings", label: "설정", isActive: (p: string) => p.startsWith("/settings") },
];

export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AppShell
      height="auto"
      contentPadding={4}
      topNav={
        <TopNav
          label="Loop 내비게이션"
          heading={<TopNavHeading heading="Loop" headingHref="/dashboard" />}
          startContent={NAV_ITEMS.map((item) => (
            <TopNavItem
              key={item.href}
              href={item.href}
              label={item.label}
              isSelected={item.isActive(pathname)}
            />
          ))}
        />
      }
    >
      {children}
    </AppShell>
  );
}
