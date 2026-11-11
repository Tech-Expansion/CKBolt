"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

const QR_OPTIONS = { margin: 1, width: 480, errorCorrectionLevel: "M" } as const;
/** How wide a QR code shows, at most. */
export const QR_DISPLAY_PX = 160;

/** A QR code image of `text`, or null while it is drawn (the text and its copy button work without it). */
function useQrDataUrl(text: string): string | null {
  const [qr, setQr] = useState<{ text: string; url: string } | null>(null);
  useEffect(() => {
    let current = true;
    QRCode.toDataURL(text, QR_OPTIONS).then(
      (url) => {
        if (current) setQr({ text, url });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [text]);
  return qr?.text === text ? qr.url : null;
}

/** `text` as a square QR code, centred; an empty square of the same size while it is drawn. */
export function QrCode({ text, alt, sizePx = QR_DISPLAY_PX, testId }: { text: string; alt: string; sizePx?: number; testId?: string }) {
  const qr = useQrDataUrl(text);
  return qr ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={qr}
      alt={alt}
      width={sizePx}
      height={sizePx}
      style={{ maxWidth: sizePx }}
      className="mx-auto w-full border border-foreground/10"
      data-testid={testId}
    />
  ) : (
    <div style={{ maxWidth: sizePx }} className="mx-auto aspect-square w-full border border-foreground/10" aria-hidden="true" />
  );
}
