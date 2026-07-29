#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [, , dumpArg, manifestArg] = process.argv;

if (!dumpArg || !manifestArg) {
  console.error("Usage: node scripts/verify-supabase-backup.mjs <dump.sql> <SHA256SUMS>");
  process.exit(2);
}

const dumpPath = resolve(dumpArg);
const manifestPath = resolve(manifestArg);

try {
  const info = await stat(dumpPath);
  if (!info.isFile() || info.size === 0) {
    throw new Error("backup dump is empty or not a regular file");
  }

  const dump = await readFile(dumpPath);
  const manifest = await readFile(manifestPath, "utf8");
  const digest = createHash("sha256").update(dump).digest("hex");
  const expected = manifest
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([hash, file]) => hash?.toLowerCase() === digest && file && basename(file) === basename(dumpPath));

  if (!expected) {
    throw new Error(`SHA-256 mismatch for ${basename(dumpPath)}`);
  }

  console.log(JSON.stringify({ verified: true, file: dumpPath, sha256: digest }));
} catch (error) {
  console.error(`Backup verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
