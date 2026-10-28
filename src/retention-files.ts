import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { TxdError } from "./model.js";

/** Open private regular files without following links or accepting hard links. */
export const openPrivate = (path: string, flags: number): number => {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077) {
    closeSync(fd);
    throw new TxdError(
      "RETENTION_PATH_UNSAFE",
      "Retention files must be private regular files.",
    );
  }
  return fd;
};

/** Verify a private directory and canonicalize ordinary ancestor aliases. */
export const privateDirectory = (path: string): string => {
  const selected = resolve(path);
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  const info = lstatSync(selected);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new TxdError(
      "RETENTION_PATH_UNSAFE",
      "Retention directory must be private and unlinked.",
    );
  return realpathSync(selected);
};

/** Flush a containing directory after publishing a durable archive. */
export const syncDirectory = (path: string): void => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Read through a verified descriptor rather than reopening a checked path. */
export const privateRead = (path: string): Buffer => {
  const fd = openPrivate(path, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size > 17 * 1024 * 1024)
      throw new Error("Retention file exceeds its bound");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Publish bytes before any ledger compaction; interrupted writes are rebuildable. */
export const publishArchive = (path: string, bytes: Buffer): void => {
  const pending = `${path}.pending`;
  const fd = openPrivate(pending, constants.O_WRONLY | constants.O_CREAT);
  try {
    // Check ownership/type before truncating an orphan from an interrupted attempt.
    writeFileSync(fd, bytes);
    // A previous longer pending file must not leave a corrupt gzip tail.
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(pending, path);
  syncDirectory(dirname(path));
};
