import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isPublicApiPath } from "@/lib/public-api-paths";

/**
 * PLAN.md §14.2/§36/§46.2 acceptance criteria — "A new route added with no
 * requireAuth call and not on the public allowlist fails CI ... verified
 * by the same kind of deliberate-violation test" as §33.4 item 4's raw-
 * Prisma-import check. Walks every `src/app/api/**\/route.ts` file exactly
 * as §14.2 describes: it must be on the public allowlist
 * (`src/lib/public-api-paths.ts`, the same one `src/proxy.ts` uses) or
 * import `requireAuth`.
 */

const API_ROOT = path.join(process.cwd(), "src", "app", "api");

function listRouteFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRouteFiles(full));
    } else if (entry.name === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

function toApiPathname(routeFile: string): string {
  const relative = path.relative(API_ROOT, routeFile).replace(/\\/g, "/");
  const withoutRouteFile = relative.replace(/\/route\.ts$/, "");
  return `/api/${withoutRouteFile}`;
}

function isCovered(routeFile: string): boolean {
  const pathname = toApiPathname(routeFile);
  if (isPublicApiPath(pathname)) return true;
  const source = fs.readFileSync(routeFile, "utf8");
  return source.includes("requireAuth");
}

describe("every src/app/api/**/route.ts is public-allowlisted or calls requireAuth (§14.2/§36)", () => {
  const routeFiles = listRouteFiles(API_ROOT);

  it("found a non-trivial number of route files (sanity check the walk itself works)", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it.each(routeFiles.map((f) => [path.relative(process.cwd(), f), f] as const))(
    "%s",
    (_label, routeFile) => {
      expect(isCovered(routeFile)).toBe(true);
    }
  );
});

describe("deliberate-violation test: an uncovered route is caught (§33.4 item 4's pattern, applied to §14.2)", () => {
  const scratchDir = path.join(API_ROOT, "__coverage_scratch__");
  const scratchFile = path.join(scratchDir, "route.ts");

  afterEach(() => {
    if (fs.existsSync(scratchFile)) fs.unlinkSync(scratchFile);
    if (fs.existsSync(scratchDir)) fs.rmdirSync(scratchDir);
  });

  it("flags a new route with no requireAuth call and no public-allowlist entry", () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(
      scratchFile,
      `import { NextResponse } from "next/server";\n\nexport async function GET() {\n  return NextResponse.json({ leaked: true });\n}\n`,
      "utf8"
    );

    expect(isCovered(scratchFile)).toBe(false);
  });

  it("does not flag a route that does call requireAuth", () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(
      scratchFile,
      `import { requireAuth, isAuthenticated } from "@/lib/route-auth";\nimport { NextRequest, NextResponse } from "next/server";\n\nexport async function GET(request: NextRequest) {\n  const ctx = await requireAuth(request, "customers:read");\n  if (!isAuthenticated(ctx)) return ctx;\n  return NextResponse.json({ ok: true });\n}\n`,
      "utf8"
    );

    expect(isCovered(scratchFile)).toBe(true);
  });
});
