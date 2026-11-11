"use client";

import { useState } from "react";
import { Zap } from "lucide-react";

/**
 * Decorative token logo; the token's symbol is always shown as text next to it. `icon` is one source or several to try
 * in order (the hub's icon, then the app's own: lib/token-display.ts `tokenIcons`): one that fails to load (a broken
 * URL, or an icon from another host that the node page's cross-origin isolation blocks) gives way to the next, and the
 * symbol's initials show when none loads. Icons are only ever images (`<img src>`), never inlined markup.
 */
export function TokenIcon({
  symbol,
  icon,
  size = 24,
  lightning = false,
}: {
  symbol: string;
  icon?: string | readonly (string | null | undefined)[];
  size?: number;
  lightning?: boolean;
}) {
  const sources = (typeof icon === "string" ? [icon] : (icon ?? [])).filter((src): src is string => !!src);
  const key = sources.join("\n");
  // How many of these sources failed; a new list starts again from its first.
  const [failed, setFailed] = useState<{ key: string; count: number }>({ key, count: 0 });
  const count = failed.key === key ? failed.count : 0;
  const src = sources[count];
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden="true" data-token-icon={src ? "image" : "initials"}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          // An icon from another host learns nothing of the page it shows on.
          referrerPolicy="no-referrer"
          onError={() => setFailed({ key, count: count + 1 })}
          className="rounded-full bg-white ring-1 ring-foreground/10 object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="rounded-full bg-foreground text-background font-mono font-medium flex items-center justify-center ring-1 ring-foreground/10"
          style={{ width: size, height: size, fontSize: Math.max(9, size * 0.36) }}
        >
          {symbol.slice(0, 2).toUpperCase()}
        </span>
      )}
      {lightning && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[#f7931a] text-white flex items-center justify-center ring-2 ring-background"
          style={{ width: size * 0.5, height: size * 0.5 }}
        >
          <Zap style={{ width: size * 0.32, height: size * 0.32 }} fill="currentColor" strokeWidth={0} />
        </span>
      )}
    </span>
  );
}
