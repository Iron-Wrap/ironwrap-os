import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BarcodeCamera } from "./barcode-camera";

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const getUserMedia = vi.fn<typeof navigator.mediaDevices.getUserMedia>();
const decode = vi.fn<(source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>>();
let frames: FrameRequestCallback[];

function cameraStream() {
  const stop = vi.fn();
  const stream = new MediaStream();
  // HappyDOM enforces MediaStream identity, but does not implement its track methods.
  Object.defineProperty(stream, "getTracks", { value: () => [{ stop }] });
  return { stream, stop };
}

beforeEach(() => {
  getUserMedia.mockReset();
  decode.mockReset().mockResolvedValue([]);
  frames = [];
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal(
    "BarcodeDetector",
    class {
      detect = decode;
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("optional label camera", () => {
  it("offers the scanner fallback without asking for a camera on unsupported browsers", () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    render(<BarcodeCamera onBarcode={vi.fn()} />);
    expect(screen.getByText(/Camera scanning is unavailable/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Scan with camera" })).not.toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("starts only after the camera choice, emits one decoded value and stops every track", async () => {
    const camera = cameraStream();
    const onBarcode = vi.fn();
    getUserMedia.mockResolvedValue(camera.stream);
    decode.mockResolvedValue([{ rawValue: "  LOT-READ-001  " }]);
    render(<BarcodeCamera onBarcode={onBarcode} />);
    expect(getUserMedia).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    await screen.findByRole("button", { name: "Reading label…" });
    await act(async () => {
      frames.shift()!(performance.now());
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    expect(onBarcode).toHaveBeenCalledExactlyOnceWith("LOT-READ-001");
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(screen.getByText(/Check the resolved identity before recording/)).toBeVisible();
    expect(screen.getByLabelText("Barcode camera preview")).toHaveProperty("srcObject", null);
  });

  it("keeps a denied camera permission as a retryable fallback, without a stock callback", async () => {
    const onBarcode = vi.fn();
    getUserMedia.mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));
    render(<BarcodeCamera onBarcode={onBarcode} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));

    expect(await screen.findByText(/Camera access is unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Scan with camera" })).toBeEnabled();
    expect(onBarcode).not.toHaveBeenCalled();
  });

  it("releases a late permission result after the user closes the camera", async () => {
    const camera = cameraStream();
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    render(<BarcodeCamera onBarcode={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    await userEvent.click(screen.getByRole("button", { name: "Close camera" }));
    await act(async () => {
      grant(camera.stream);
    });

    expect(camera.stop).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("stops a running camera on unmount and discards a late decode", async () => {
    const camera = cameraStream();
    const onBarcode = vi.fn();
    let decoded!: (value: Array<{ rawValue: string }>) => void;
    getUserMedia.mockResolvedValue(camera.stream);
    decode.mockReturnValue(
      new Promise((resolve) => {
        decoded = resolve;
      }),
    );
    const view = render(<BarcodeCamera onBarcode={onBarcode} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
    await screen.findByRole("button", { name: "Reading label…" });
    await act(async () => {
      frames.shift()!(performance.now());
    });
    view.unmount();
    await act(async () => {
      decoded([{ rawValue: "LATE-LABEL" }]);
    });

    expect(camera.stop).toHaveBeenCalledOnce();
    expect(onBarcode).not.toHaveBeenCalled();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });
});
