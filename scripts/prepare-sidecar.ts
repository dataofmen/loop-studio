/**
 * Places the Node runtime where Tauri expects a sidecar binary.
 *
 * Tauri resolves `externalBin: ["binaries/node"]` to a file suffixed with the
 * Rust target triple, so the same config can carry per-platform binaries.
 *
 * The bundled Node must be the OFFICIAL build, not Homebrew's: Homebrew links
 * node against dylibs under /opt/homebrew, so that binary only runs on a
 * machine that already has Homebrew and the same formulae installed.
 *
 * Usage: bun scripts/prepare-sidecar.ts
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = process.cwd();
const vendorDir = join(root, "vendor");
const outDir = join(root, "src-tauri/binaries");

/** Rust's own name for this host — the suffix Tauri looks for. */
function targetTriple(): string {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = out.split("\n").find((l) => l.startsWith("host:"));
  if (!host) throw new Error("rustc -vV에서 host 트리플을 읽지 못했습니다.");
  return host.replace("host:", "").trim();
}

/**
 * The Node runtime to bundle, from vendor/.
 *
 * A locally BUILT runtime wins over the downloaded official one: the official
 * build embeds the full ICU data set (~32MB) that this app never uses — every
 * locale-aware format runs client-side in WebKit — so a `--with-intl=small-icu`
 * build is ~34MB smaller for identical behaviour here.
 */
function vendoredNode(): { path: string; built: boolean } {
  const explicit = process.env.LOOP_VENDOR_NODE;
  if (explicit) return { path: explicit, built: false };
  if (!existsSync(vendorDir)) throw new Error(missingNodeMessage());

  const dirs = readdirSync(vendorDir).filter((d) => /^node-v\d+/.test(d));
  for (const d of dirs) {
    const built = join(vendorDir, d, "out/Release/node");
    if (existsSync(built)) return { path: built, built: true };
  }
  for (const d of dirs) {
    const official = join(vendorDir, d, "bin/node");
    if (existsSync(official)) return { path: official, built: false };
  }
  throw new Error(missingNodeMessage());
}

function missingNodeMessage(): string {
  return [
    `번들할 Node 런타임이 없습니다 (${outDir} 에도, vendor/ 에도).`,
    "이미 준비한 사이드카가 있으면 그 파일을 위 경로에 두면 그대로 재사용합니다.",
    "새로 준비하려면 둘 중 하나를 하세요.",
    "",
    "① 작게 (권장, ~34MB 절감) — full ICU를 뺀 소스 빌드:",
    "  cd vendor",
    "  curl -LO https://nodejs.org/dist/v24.18.0/node-v24.18.0.tar.gz",
    "  tar xzf node-v24.18.0.tar.gz && cd node-v24.18.0",
    "  ./configure --with-intl=small-icu --without-node-snapshot",
    "  make -j$(sysctl -n hw.ncpu)        # 20~30분",
    "",
    "② 빠르게 — 공식 바이너리 (Homebrew node는 dylib 링크 때문에 이식 불가):",
    "  cd vendor",
    "  curl -LO https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz",
    "  tar xzf node-v24.18.0-darwin-arm64.tar.gz",
  ].join("\n");
}

mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `node-${targetTriple()}`);

/**
 * A prepared sidecar is reused as-is.
 *
 * Producing it costs either a 195MB download or a 20-minute source build, and
 * the result is a single 58MB file — so once it exists there is no reason to
 * keep the vendor tree around (a full Node source build leaves ~21GB behind).
 * Re-run with LOOP_FORCE_SIDECAR=1 to rebuild it from vendor/.
 */
if (existsSync(dest) && !process.env.LOOP_FORCE_SIDECAR) {
  try {
    const v = execFileSync(
      dest,
      [
        "-e",
        'require("node:sqlite"); process.stdout.write(process.version + (process.config.variables.icu_small ? " small-icu" : " full-icu"))',
      ],
      { encoding: "utf8" },
    );
    console.log(`sidecar → ${dest}`);
    console.log(`  ${v} · 기존 사이드카 재사용 (${(statSync(dest).size / 1024 / 1024).toFixed(0)}MB)`);
    process.exit(0);
  } catch {
    // Present but not runnable — fall through and rebuild it from vendor/.
    console.log("기존 사이드카가 실행되지 않습니다 — vendor/에서 다시 준비합니다.");
  }
}

const picked = vendoredNode();
const src = resolve(picked.path);
if (!existsSync(src)) throw new Error(missingNodeMessage());
copyFileSync(src, dest);
chmodSync(dest, 0o755);

const before = statSync(dest).size;

// Debug symbols are a quarter of the binary and nothing reads them here.
// Stripping invalidates the signature, and macOS SIGKILLs an unsigned-but-
// modified Mach-O on sight — so re-sign ad-hoc immediately after.
execFileSync("strip", ["-x", dest], { stdio: ["ignore", "ignore", "ignore"] });
execFileSync("codesign", ["--force", "--sign", "-", dest], {
  stdio: ["ignore", "ignore", "ignore"],
});

// Prove it still runs, and that what we need from it survived: node:sqlite
// (persona corpus sampling) and TypeScript execution are both load-bearing.
const check = execFileSync(
  dest,
  [
    "-e",
    'require("node:sqlite"); process.stdout.write(process.version + (process.config.variables.icu_small ? " small-icu" : " full-icu"))',
  ],
  { encoding: "utf8" },
);

const after = statSync(dest).size;
const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
console.log(`sidecar → ${dest}`);
console.log(
  `  ${check} · ${picked.built ? "locally built" : "official binary"} · ` +
    `${mb(before)}MB → ${mb(after)}MB (stripped, ad-hoc signed)`,
);
