import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  openPrivate,
  privateDirectory,
  publishArchive,
  syncDirectory,
} from "./retention-files.js";

/** Fixed production log policy: 10 MiB active file plus five gzip archives. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Number of historical diagnostic log segments retained. */
export const LOG_ARCHIVES = 5;

/** Single-writer byte-bounded log, owned by the daemon's repository lock. */
export class RotatingLog {
  private readonly fd: number;
  readonly path: string;
  constructor(
    path: string,
    private readonly maxBytes = LOG_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid log bound");
    this.path = join(privateDirectory(dirname(path)), basename(path));
    this.fd = openPrivate(
      this.path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
    );
    try {
      if (fstatSync(this.fd).size > maxBytes) this.rotate();
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }

  /** Write all bytes, splitting even an oversized record into bounded segments. */
  write(record: unknown): void {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    for (let offset = 0; offset < bytes.length;) {
      let size = fstatSync(this.fd).size;
      if (size >= this.maxBytes) {
        this.rotate();
        size = 0;
      }
      const length = Math.min(this.maxBytes - size, bytes.length - offset);
      offset += writeSync(this.fd, bytes, offset, length);
    }
  }

  private rotate(): void {
    const size = fstatSync(this.fd).size;
    // Import an oversized existing log with bounded memory; oldest segments expire.
    const start =
      Math.max(0, Math.ceil(size / this.maxBytes) - LOG_ARCHIVES) *
      this.maxBytes;
    for (let offset = start; offset < size; offset += this.maxBytes) {
      const bytes = Buffer.alloc(Math.min(this.maxBytes, size - offset));
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(
          this.fd,
          bytes,
          count,
          bytes.length - count,
          offset + count,
        );
        if (!read) throw new Error("Log changed during rotation");
        count += read;
      }
      for (let index = LOG_ARCHIVES - 1; index >= 1; index--) {
        try {
          renameSync(
            `${this.path}.${index}.gz`,
            `${this.path}.${index + 1}.gz`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      publishArchive(`${this.path}.1.gz`, gzipSync(bytes));
    }
    // Archive and directory are durable before destroying the active copy.
    fsyncSync(this.fd);
    ftruncateSync(this.fd, 0);
    fsyncSync(this.fd);
    syncDirectory(dirname(this.path));
  }

  /** Close after the service has stopped emitting records. */
  close(): void {
    fsyncSync(this.fd);
    closeSync(this.fd);
  }
}
