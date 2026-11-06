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

  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      const v = video.current;
      if (done || !v || !ctx) return;
      if (v.readyState >= 2 && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          done = true;
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        if (done || !video.current) return;
        video.current.srcObject = s;
        void video.current.play();
        raf = requestAnimationFrame(tick);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    if (!navigator.mediaDevices) setError("no camera available in this browser");
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

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
