import { ConsoleShell } from "./console-shell";

/**
 * Everything under the console reads the local database, so nothing here can
 * be prerendered at build time — there is no database until the user runs the
 * app.
 */
export const dynamic = "force-dynamic";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
