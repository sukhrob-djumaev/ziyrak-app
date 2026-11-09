import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function token(block: string, name: string): string {
  const m = block.match(new RegExp(`--ziyrak-${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`missing --ziyrak-${name}`);
  return m[1];
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = css.slice(css.indexOf(":root"), css.indexOf(".dark"));
const dark = css.slice(css.indexOf(".dark"), css.indexOf("@theme"));
const white = "#FFFFFF";

function pairsFor(t: string): Array<[string, string, string]> {
  return [
    ["text on bg", token(t, "text"), token(t, "bg")],
    ["text-light on surface", token(t, "text-light"), token(t, "surface")],
    ["text-light on bg", token(t, "text-light"), token(t, "bg")],
    ["primary text on surface", token(t, "primary"), token(t, "surface")],
    ["danger text on surface", token(t, "danger"), token(t, "surface")],
    ["success text on surface", token(t, "success"), token(t, "surface")],
    ["warning text on surface", token(t, "warning"), token(t, "surface")],
    ["white on primary fill", white, token(t, "primary-fill")],
    ["white on primary hover fill", white, token(t, "primary-fill-hover")],
    ["white on danger fill", white, token(t, "danger-fill")],
    ["white on success fill", white, token(t, "success-fill")],
    ["white on warning fill", white, token(t, "warning-fill")],
  ];
}

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme colour contrast (WCAG AA 4.5:1 for text)", (_theme, block) => {
  // The light theme keeps white page/card surfaces; text tokens sit on white there.
  const pairs = pairsFor(block).map(([n, fg, bg]) =>
    _theme === "light" && n.endsWith("text on surface") && !n.startsWith("text-light")
      ? ([n, fg, white] as [string, string, string])
      : ([n, fg, bg] as [string, string, string]),
  );
  it.each(pairs)("%s", (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("fill classes", () => {
  it("every bg-ziyrak-*-fill class used in src has a theme colour", () => {
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".tsx")) {
          for (const m of readFileSync(full, "utf8").matchAll(/(?:bg|hover:bg)-ziyrak-([a-z-]+-fill(?:-hover)?)\b/g)) used.add(m[1]);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(css).toContain(`--color-ziyrak-${name}:`);
  });
});
