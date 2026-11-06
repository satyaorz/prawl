import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Webcam QR scanner, decoded locally with jsQR (BarcodeDetector is missing on
 * desktop Linux Chrome). Frames never leave the page. Stops the camera on
 * result, close or unmount.
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();
  // The caller's callback changes on every render; the camera must not restart with it.
  const result = useRef(onResult);
  result.current = onResult;

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    /**
     * jsQR is sensitive to how a code's modules fall on the pixel grid, so one frame is tried at
     * three scales (a code that fails at full size often decodes smaller). Camera frames are first
     * capped at 1280 px on the long side to bound the work.
     */
    const decode = (v: HTMLVideoElement): string | undefined => {
      if (!ctx) return undefined;
      const base = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
      for (const scale of [1, 0.75, 0.5]) {
        const w = Math.max(64, Math.round(v.videoWidth * base * scale));
        const h = Math.max(64, Math.round(v.videoHeight * base * scale));
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
        if (code?.data) return code.data;
      }
      return undefined;
    };
    const tick = () => {
      const v = video.current;
      if (done || !v) return;
      if (v.readyState >= 2 && v.videoWidth > 0) {
        const text = decode(v);
        if (text) {
          done = true;
          result.current(text);
          return;
        }
      }
      timer = window.setTimeout(tick, 120);
    };
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        if (done || !video.current) return;
        video.current.srcObject = s;
        void video.current.play();
        timer = window.setTimeout(tick, 120);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    if (!navigator.mediaDevices) setError("no camera available in this browser");
    return () => {
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="mt-3">
      <video ref={video} muted playsInline className="w-full rounded-lg bg-black" />
      {error && <p className="mt-2 text-xs text-red-400">Camera: {error}</p>}
      <button onClick={onClose} className="mt-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs">
        Stop scanning
      </button>
    </div>
  );
}
