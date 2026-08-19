import { describe, expect, test } from "bun:test";
import { decodeFrame, encodeFrame, FrameReader } from "../host/native-protocol";

describe("native-protocol", () => {
  test("encode/decode roundtrip", () => {
    const msg = { t: "echo", text: "你好" };
    const frame = encodeFrame(msg);
    expect(frame.length).toBe(4 + Buffer.byteLength(JSON.stringify(msg), "utf8"));
    expect(decodeFrame(Buffer.from(frame))).toEqual(msg);
  });

  test("large frame within 1MB limit", () => {
    const msg = { t: "echo", text: "x".repeat(100_000) };
    const frame = encodeFrame(msg);
    expect(frame.length).toBeGreaterThan(100_000);
    const decoded = decodeFrame(Buffer.from(frame)) as { text: string };
    expect(decoded.text.length).toBe(100_000);
  });

  test("frame over 1MB rejected", () => {
    expect(() => encodeFrame({ t: "echo", text: "x".repeat(1024 * 1024 + 1) })).toThrow(/too large/);
  });

  test("FrameReader splits chunked stream", async () => {
    const msg = { t: "echo", text: "hello" };
    const frame = Buffer.from(encodeFrame(msg));
    // 每 5 字节切一刀模拟分块到达
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i += 5) {
      chunks.push(frame.subarray(i, i + 5));
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const reader = new FrameReader(stream);
    const frames: Buffer[] = [];
    for await (const f of reader.frames()) frames.push(f);
    expect(frames.length).toBe(1);
    expect(decodeFrame(frames[0])).toEqual(msg);
  });

  test("FrameReader discards oversized frame and continues", async () => {
    // 构造一个长度字段超限(>1MB)的假帧,再跟一个合法帧
    const big = Buffer.alloc(8);
    big.writeUInt32LE(2 * 1024 * 1024, 0); // 声明 2MB
    const ok = Buffer.from(encodeFrame({ t: "ping" }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big);
        c.enqueue(ok);
        c.close();
      },
    });
    const reader = new FrameReader(stream);
    const frames: Buffer[] = [];
    for await (const f of reader.frames()) frames.push(f);
    expect(frames.length).toBe(1);
    expect(decodeFrame(frames[0])).toEqual({ t: "ping" });
  });

  test("FrameReader errors on trailing garbage", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from([0x01, 0x02, 0x03]));
        controller.close();
      },
    });
    const reader = new FrameReader(stream);
    await expect(async () => {
      for await (const _ of reader.frames()) {
        // consume
      }
    }).toThrow(/trailing bytes/);
  });
});
