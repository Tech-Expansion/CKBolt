import Link from "next/link";
import type { ComponentProps } from "react";
import { isClientNavigable } from "@/lib/site-links";

/**
 * A link of the site: client-side (next/link) to the site's own pages, so the header's Fiber node keeps its node
 * running; a plain anchor to the isolated pages (they need a full load for their headers), to other sites, and always
 * when `fullLoad` (the isolated node page, whose document must not carry its isolation into another page).
 */
export function SiteLink({ href, fullLoad = false, ...props }: ComponentProps<"a"> & { href: string; fullLoad?: boolean }) {
  return !fullLoad && isClientNavigable(href) ? <Link href={href} {...props} /> : <a href={href} {...props} />;
}
