#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/;

function repoPath(...segments) {
  return path.join(ROOT, ...segments);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readVersion() {
  return fs.readFileSync(repoPath("VERSION"), "utf8").trim();
}

function writeVersion(version) {
  fs.writeFileSync(repoPath("VERSION"), `${version}\n`);
}

function readCargoVersion() {
  const manifest = fs.readFileSync(repoPath("Cargo.toml"), "utf8");
  return manifest.match(/\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"\n/)?.[1];
}

function readCargoLockVersion() {
  const lockfile = fs.readFileSync(repoPath("Cargo.lock"), "utf8");
  return lockfile.match(
    /\[\[package\]\]\nname = "stella-text-search-core"\nversion = "([^"]+)"\n/,
  )?.[1];
}

function writeCargoVersion(version) {
  const manifestPath = repoPath("Cargo.toml");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const nextManifest = manifest.replace(
    /(\[workspace\.package\][\s\S]*?\nversion = ")[^"]+("\n)/,
    `$1${version}$2`,
  );
  if (nextManifest === manifest && readCargoVersion() !== version) {
    throw new Error("Cargo.toml has no workspace.package version");
  }
  fs.writeFileSync(manifestPath, nextManifest);
}

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  const args = new Map();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--version" || token === "--tag") {
      const value = rest[i + 1];
      if (value == null) {
        throw new Error(`Missing value for ${token}`);
      }
      args.set(token.slice(2), value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { command, args };
}

function syncVersion(nextVersion) {
  const rootPath = repoPath("package.json");
  const wasmPath = repoPath("wasm", "package.json");

  const root = readJson(rootPath);
  const wasm = readJson(wasmPath);

  writeVersion(nextVersion);
  root.version = nextVersion;
  wasm.version = nextVersion;

  writeJson(rootPath, root);
  writeJson(wasmPath, wasm);
  writeCargoVersion(nextVersion);
}

function describeMismatches(expectedVersion) {
  const mismatches = [];
  const rootPath = repoPath("package.json");
  const wasmPath = repoPath("wasm", "package.json");

  const root = readJson(rootPath);
  const wasm = readJson(wasmPath);

  const version = readVersion();
  if (version !== expectedVersion) {
    mismatches.push(`${repoPath("VERSION")}: version=${version}`);
  }
  if (root.version !== expectedVersion) {
    mismatches.push(`${rootPath}: version=${root.version}`);
  }
  if (wasm.version !== expectedVersion) {
    mismatches.push(`${wasmPath}: version=${wasm.version}`);
  }
  const cargoVersion = readCargoVersion();
  if (cargoVersion !== expectedVersion) {
    mismatches.push(`${repoPath("Cargo.toml")}: workspace.package.version=${cargoVersion}`);
  }
  const cargoLockVersion = readCargoLockVersion();
  if (cargoLockVersion !== expectedVersion) {
    mismatches.push(`${repoPath("Cargo.lock")}: package.version=${cargoLockVersion}`);
  }

  return mismatches;
}

function main() {
  const { command, args } = parseArgs();

  if (command !== "sync" && command !== "check") {
    console.error(
      "Usage: node scripts/version-sync.mjs <sync|check> [--version <semver>] [--tag <git-tag>]",
    );
    process.exit(1);
  }

  const version = args.get("version") ?? args.get("tag")?.replace(/^v/, "") ?? readVersion();
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version '${version}'`);
  }

  if (command === "sync") {
    syncVersion(version);
    return;
  }

  if (command === "check") {
    const mismatches = describeMismatches(version);
    if (mismatches.length > 0) {
      console.error("Version drift detected:");
      for (const mismatch of mismatches) {
        console.error(`- ${mismatch}`);
      }
      process.exit(1);
    }
    return;
  }
}

main();
