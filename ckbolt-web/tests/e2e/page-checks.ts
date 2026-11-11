import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** The WCAG levels the suite checks (style guide: Accessibility conventions). */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const FAILING_IMPACTS = new Set(["serious", "critical"]);
/** How many offending elements a failure lists. */
const MAX_LISTED = 10;

/** Every visible element with text inside <main> must fit the viewport width, unless an ancestor scrolls sideways. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflowing = await page.evaluate((max) => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll("main *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.children.length) continue;
      if (getComputedStyle(el).display === "none") continue;
      let p = el.parentElement;
      let scrolls = false;
      while (p) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll") scrolls = true;
        p = p.parentElement;
      }
      if (!scrolls && r.right > vw + 1 && (el.textContent ?? "").trim()) out.push(`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out.slice(0, max);
  }, MAX_LISTED);
  expect(overflowing).toEqual([]);
}

/** No serious or critical axe finding on the page, or inside `include` (a CSS selector). The CCC connector is not ours. */
export async function expectNoSeriousAxe(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(AXE_TAGS).exclude("ccc-connector");
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => FAILING_IMPACTS.has(v.impact ?? ""));
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`)).toEqual([]);
}
