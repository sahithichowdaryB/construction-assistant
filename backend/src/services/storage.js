import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * File storage behind one small interface so Supabase Storage (or S3) can replace local disk later.
 * Keys are POSIX paths relative to the root: "<projectId>/<name>".
 */
export function createDiskStorage(root) {
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  };
  return {
    async put(projectId, name, buffer) {
      const key = path.posix.join(projectId, name);
      await fs.mkdir(path.dirname(resolve(key)), { recursive: true });
      await fs.writeFile(resolve(key), buffer);
      return { key, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
    },
    get: (key) => fs.readFile(resolve(key)),
  };
}
