"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Camera, ImageUp, X } from "lucide-react";

function decodeFromCanvas(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(data, width, height)?.data ?? null;
}

type CameraState = "off" | "starting" | "on";

const SCAN_INTERVAL_MS = 120;
const MAX_SCAN_SIDE = 640;
const MAX_IMAGE_SIDE = 1600;
const MAX_FALLBACK_SIDE = 4096;

/**
 * Scan a QR code with the camera or from an image file.
 * The camera always stops on a result, on Stop, when `enabled` turns false
 * (for example when the user switches tab) and on unmount.
 */
export function QrScanner({ onResult, enabled = true }: { onResult: (text: string) => void; enabled?: boolean }) {
  const [camera, setCamera] = useState<CameraState>("off");
  const [error, setError] = useState<string>();
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef(0);
  const sessionRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const stop = useCallback(() => {
    sessionRef.current += 1; // invalidates any start still waiting for permission
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("off");
  }, []);

  useEffect(() => stop, [stop]);
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  // Release the camera when the page is hidden (tab switch, phone locked).
  useEffect(() => {
    const onHide = () => document.hidden && stop();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [stop]);

  // Attach the stream once the <video> element exists.
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const session = sessionRef.current;
    let last = 0;
    const tick = (time = 0) => {
      if (session !== sessionRef.current) return;
      // About 8 scans a second on a frame scaled to 640 px keeps phones responsive.
      if (time - last >= SCAN_INTERVAL_MS && video.readyState >= 2 && video.videoWidth) {
        last = time;
        const scale = Math.min(1, MAX_SCAN_SIDE / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        const text = decodeFromCanvas(canvas);
        if (text) {
          stop();
          onResultRef.current(text);
          return;
        }
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [stop]);

  const startCamera = async () => {
    if (camera !== "off") return;
    setError(undefined);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot open the camera here. Upload a photo of the QR code instead.");
      return;
    }
    const session = ++sessionRef.current;
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (session !== sessionRef.current) {
        // Stopped or switched away while the permission prompt was open.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setCamera("on");
    } catch (e) {
      if (session === sessionRef.current) {
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found. Upload a photo of the QR code instead."
            : name === "NotReadableError"
              ? "The camera is in use by another app. Close it, or upload a photo of the QR code."
              : "Camera access was blocked. Allow the camera, or upload a photo of the QR code.",
        );
        setCamera("off");
      }
    }
  };

  const readFile = (file: File) => {
    setError(undefined);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // Phone photos can be 48 MP: decode a scaled copy first, which is fast and
      // stays under mobile canvas limits, and only fall back to full size if needed.
      const decodeAt = (maxSide: number) => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
        return decodeFromCanvas(canvas);
      };
      const text = decodeAt(MAX_IMAGE_SIDE) ?? (Math.max(img.naturalWidth, img.naturalHeight) > MAX_IMAGE_SIDE ? decodeAt(MAX_FALLBACK_SIDE) : null);
      URL.revokeObjectURL(url);
      if (text) onResultRef.current(text);
      else setError("No QR code found in that image. Try a sharper, closer photo.");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError("That file could not be read as an image.");
    };
    img.src = url;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-sm">
        {camera === "off" ? (
          <button
            type="button"
            onClick={startCamera}
            className="inline-flex items-center gap-2 border border-foreground/20 rounded-full px-4 h-9 hover:bg-foreground/5"
          >
            <Camera className="w-4 h-4" /> Scan QR with camera
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="inline-flex items-center gap-2 border border-foreground/20 rounded-full px-4 h-9 hover:bg-foreground/5"
          >
            <X className="w-4 h-4" /> {camera === "starting" ? "Cancel" : "Stop camera"}
          </button>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 border border-foreground/20 rounded-full px-4 h-9 hover:bg-foreground/5"
        >
          <ImageUp className="w-4 h-4" /> Upload QR image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Upload QR image"
          data-testid="qr-upload"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) readFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {camera === "starting" && <p className="text-sm text-muted-foreground">Waiting for camera permission…</p>}
      {camera === "on" && (
        <div className="relative w-full max-w-sm aspect-square border border-foreground/15 bg-foreground/5 overflow-hidden">
          <video ref={attachVideo} muted playsInline className="w-full h-full object-cover" aria-label="Camera preview" />
          <span className="absolute inset-8 border-2 border-background/80 pointer-events-none" aria-hidden="true" />
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
