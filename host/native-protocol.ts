// Native Messaging 帧协议:4 字节小端 uint32 长度前缀 + UTF-8 JSON。

const MAX_FRAME_BYTES = 1024 * 1024; // 与 Chrome 上限一致

export function encodeFrame(message: unknown): Uint8Array {
  const data = Buffer.from(JSON.stringify(message), "utf8");
  if (data.length > 1024 * 1024) {
    throw new Error(`frame too large: ${data.length} bytes (max 1MB)`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(data.length, 0);
  return Buffer.concat([head, data]);
}

export function decodeFrame(buf: Buffer): unknown {
  if (buf.length < 4) throw new Error("frame too short");
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) throw new Error("truncated frame");
  const body = buf.subarray(4, 4 + len).toString("utf8");
  return JSON.parse(body);
}

// 从字节 chunk 流切出完整帧。
export class FrameReader {
  private buffer = Buffer.alloc(0);

  constructor(private stream: AsyncIterable<Uint8Array>) {}

  async *frames(): AsyncGenerator<Buffer> {
    for await (const chunk of this.stream) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      while (true) {
        if (this.buffer.length < 4) break;
        const len = this.buffer.readUInt32LE(0);
        if (len > MAX_FRAME_BYTES) {
          // 超限帧:无法确定边界,丢弃剩余缓冲,防止内存被撑爆
          console.error(`frame too large: ${len} bytes, discarding buffer`);
          this.buffer = Buffer.alloc(0);
          break;
        }
        if (this.buffer.length < 4 + len) break;
        const frame = this.buffer.subarray(0, 4 + len);
        this.buffer = this.buffer.subarray(4 + len);
        yield frame;
      }
    }
    if (this.buffer.length > 0) {
      throw new Error(`trailing bytes without complete frame: ${this.buffer.length}`);
    }
  }
}
