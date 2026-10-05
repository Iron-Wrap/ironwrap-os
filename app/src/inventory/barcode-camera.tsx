import { Camera, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = new () => Detector;

/** Camera decodes one label locally. The caller performs a read; recording remains a separate choice. */
export function BarcodeCamera({
  onBarcode,
  disabled = false,
}: {
  onBarcode: (value: string) => void;
  disabled?: boolean;
}) {
  const DetectorClass = (
    globalThis as typeof globalThis & { BarcodeDetector?: DetectorConstructor }
  ).BarcodeDetector;
  const supported = Boolean(DetectorClass && navigator.mediaDevices?.getUserMedia);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const frame = useRef<number | undefined>(undefined);
  const [phase, setPhase] = useState<"idle" | "starting" | "scanning">("idle");
  const [message, setMessage] = useState<string>();

  const releaseCamera = useCallback(() => {
    generation.current += 1;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);
  function stop() {
    releaseCamera();
    setPhase("idle");
  }
  useEffect(() => () => releaseCamera(), [releaseCamera]);

  async function start() {
    if (!DetectorClass || !supported || disabled || phase !== "idle") return;
    const active = ++generation.current;
    setMessage(undefined);
    setPhase("starting");
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (generation.current !== active) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = next;
      if (!video.current) throw new Error("Camera preview unavailable");
      video.current.srcObject = next;
      await video.current.play();
      if (generation.current !== active) return;
      const detector = new DetectorClass();
      setPhase("scanning");
      async function detect() {
        if (generation.current !== active || !video.current) return;
        try {
          const matches = video.current.readyState >= 2 ? await detector.detect(video.current) : [];
          if (generation.current !== active) return;
          const value = matches.find((match) => match.rawValue.trim())?.rawValue.trim();
          if (value) {
            stop();
            setMessage("Label read. Check the resolved identity before recording a scan.");
            onBarcode(value);
            return;
          }
          frame.current = requestAnimationFrame(() => void detect());
        } catch {
          if (generation.current === active) {
            stop();
            setMessage(
              "The camera could not decode this label. Use a scanner or enter the barcode.",
            );
          }
        }
      }
      frame.current = requestAnimationFrame(() => void detect());
    } catch {
      if (generation.current !== active) return;
      stop();
      setMessage(
        "Camera access is unavailable. Allow camera access in your browser, or use a scanner or enter the barcode.",
      );
    }
  }

  return (
    <div className="grid gap-3 border-t border-border pt-4">
      {supported ? (
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            size="field"
            disabled={disabled || phase !== "idle"}
            onClick={() => void start()}
          >
            <Camera aria-hidden="true" />
            {phase === "starting"
              ? "Opening camera…"
              : phase === "scanning"
                ? "Reading label…"
                : "Scan with camera"}
          </Button>
          {phase !== "idle" ? (
            <Button type="button" variant="secondary" size="field" onClick={stop}>
              <X aria-hidden="true" />
              Close camera
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">
          Camera scanning is unavailable in this browser. Use a hardware scanner or enter the
          barcode.
        </p>
      )}
      <video
        ref={video}
        muted
        playsInline
        aria-label="Barcode camera preview"
        className={
          phase === "idle" ? "hidden" : "aspect-video w-full rounded-md bg-foreground object-cover"
        }
      />
      {message ? (
        <p role="status" className="text-sm leading-6">
          {message}
        </p>
      ) : null}
    </div>
  );
}
