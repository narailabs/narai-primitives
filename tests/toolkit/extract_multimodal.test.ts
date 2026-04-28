import { describe, it, expect } from "vitest";
import { dispatchMultimodal } from "../../src/toolkit/extract_multimodal.js";

describe("dispatchMultimodal", () => {
  it("routes .png to vision mode", () => {
    const r = dispatchMultimodal("/tmp/a.png", { enabled: true });
    expect(r.format).toBe("vision");
  });

  it("routes .mp3 to audio_video when faster-whisper is probed missing", () => {
    const r = dispatchMultimodal("/tmp/a.mp3", { enabled: true });
    if (r.format === "skipped") {
      expect(r.warning).toMatch(/faster-whisper/);
    } else {
      expect(r.format).toBe("audio_video");
    }
  });

  it("routes youtube URL to youtube dispatch", () => {
    const r = dispatchMultimodal("https://www.youtube.com/watch?v=abc", {
      enabled: true,
    });
    expect(["youtube", "skipped"]).toContain(r.format);
  });

  it("skips when disabled in config", () => {
    const r = dispatchMultimodal("/tmp/a.png", { enabled: false });
    expect(r.format).toBe("skipped");
    expect(r.warning).toMatch(/disabled/);
  });
});
