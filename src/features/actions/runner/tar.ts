/**
 * Minimal, dependency-free USTAR writer for the checkout route.
 *
 * The `/internal/actions/checkout` route serves the run-pinned tree as a tar so
 * the container can extract it into its workspace without a git binary speaking
 * an HMAC-authenticated smart-HTTP dialect. Only regular files + directories are
 * emitted (symlinks are skipped by the caller). This is not a general archiver;
 * it produces exactly the entries the executor needs to reconstruct a checkout.
 */

const BLOCK = 512;

export interface TarEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Git file mode (e.g. `100644` / `100755`); mapped to a POSIX permission. */
  readonly gitMode: string;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeString(header: Uint8Array, offset: number, value: string, max: number): void {
  const bytes = new TextEncoder().encode(value);
  header.set(bytes.subarray(0, max), offset);
}

function permFromGitMode(gitMode: string): number {
  return gitMode === "100755" ? 0o755 : 0o644;
}

function buildHeader(path: string, size: number, gitMode: string): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, path, 100);
  writeString(header, 100, octal(permFromGitMode(gitMode), 8), 8);
  writeString(header, 108, octal(0, 8), 8); // uid
  writeString(header, 116, octal(0, 8), 8); // gid
  writeString(header, 124, octal(size, 12), 12);
  writeString(header, 136, octal(0, 12), 12); // mtime (deterministic)
  header.fill(0x20, 148, 156); // checksum field starts as spaces
  header[156] = 0x30; // typeflag '0' (regular file)
  writeString(header, 257, "ustar\0", 6);
  writeString(header, 263, "00", 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, octal(checksum, 8).slice(0, 7), 8);
  header[155] = 0x20;
  return header;
}

/** Parsed archive member (used by the container to extract a checkout). */
export interface TarMember {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** POSIX permission bits parsed from the header (mode & 0o777). */
  readonly mode: number;
}

function readOctal(bytes: Uint8Array): number {
  const text = new TextDecoder().decode(bytes).replace(/\0.*$/u, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/** Parse a USTAR archive produced by {@link writeTar} into its regular-file members. */
export function readTar(archive: Uint8Array): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((byte) => byte === 0)) break;
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/u, "");
    const mode = readOctal(header.subarray(100, 108)) & 0o777;
    const size = readOctal(header.subarray(124, 136));
    const typeflag = header[156];
    offset += BLOCK;
    const bytes = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    // Only regular files ('0' or NUL typeflag) become members.
    if ((typeflag === 0x30 || typeflag === 0x00) && name) {
      members.push({ path: name, bytes: bytes.slice(), mode });
    }
  }
  return members;
}

/** Serialize `entries` into a single USTAR archive byte buffer. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  let total = 0;
  const push = (block: Uint8Array): void => {
    blocks.push(block);
    total += block.byteLength;
  };
  for (const entry of entries) {
    push(buildHeader(entry.path, entry.bytes.byteLength, entry.gitMode));
    push(entry.bytes);
    const remainder = entry.bytes.byteLength % BLOCK;
    if (remainder !== 0) push(new Uint8Array(BLOCK - remainder));
  }
  // Two zero blocks terminate the archive.
  push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}
