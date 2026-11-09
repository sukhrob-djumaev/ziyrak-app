import { readFileSync } from "node:fs";
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

describe("light theme colour contrast (WCAG AA 4.5:1 for text)", () => {
  const white = "#FFFFFF";
  const pairs: Array<[string, string, string]> = [
    ["text on bg", token(light, "text"), token(light, "bg")],
    ["text-light on surface", token(light, "text-light"), token(light, "surface")],
    ["text-light on bg", token(light, "text-light"), token(light, "bg")],
    ["danger text on surface", token(light, "danger"), white],
    ["success text on surface", token(light, "success"), white],
    ["warning text on surface", token(light, "warning"), white],
    ["white on danger fill", white, token(light, "danger")],
    ["white on success fill", white, token(light, "success")],
    ["white on warning fill", white, token(light, "warning")],
    ["white on primary fill", white, token(light, "primary")],
  ];
  it.each(pairs)("%s", (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
