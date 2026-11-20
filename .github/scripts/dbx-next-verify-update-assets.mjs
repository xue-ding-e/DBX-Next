import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [directory, tag] = process.argv.slice(2);
assert.ok(directory && /^v\d+\.\d+\.\d+$/.test(tag), "Expected a release directory and version tag");
const version = tag.slice(1);
const read = (name) => readFileSync(join(directory, name), "utf8").trim();
const names = readdirSync(directory);
const nsis = "DBX_" + version + "_x64-setup.exe";
const msi = names.find((name) => name.startsWith("DBX_" + version + "_x64_") && name.endsWith(".msi"));
assert.ok(msi, "Missing Windows x64 MSI");
const portable = "DBX_" + version + "_x64-portable.zip";
const executable = portable.replace(".zip", ".exe");
const product = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const feed = JSON.parse(read("latest.json"));
const releaseRepo = "https://github.com/xue-ding-e/DBX-Next/releases/";
assert.deepEqual(product.plugins.updater.endpoints, [releaseRepo + "latest/download/latest.json"]);
assert.equal(feed.version, version);

for (const [platform, name] of [
  ["windows-x86_64", nsis],
  ["windows-x86_64-nsis", nsis],
  ["windows-x86_64-msi", msi],
]) {
  assert.deepEqual(feed.platforms[platform], {
    signature: read(name + ".sig"),
    url: releaseRepo + "download/" + tag + "/" + name,
  }, "Incorrect update entry " + platform);
}

async function hash(name, algorithm = "sha256") {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(join(directory, name))) digest.update(chunk);
  return digest.digest();
}

// Tauri wraps the Minisign records in Base64. ED denotes BLAKE2b-prehashed
// Ed25519 signatures. The global signature also binds the trusted comment.
const lines = (encoded) => Buffer.from(encoded, "base64").toString("utf8").trimEnd().split(/\r?\n/);
const keyRecord = Buffer.from(lines(product.plugins.updater.pubkey)[1], "base64");
assert.equal(keyRecord.length, 42, "Invalid updater public key");
assert.match(keyRecord.toString("ascii", 0, 2), /^E[dD]$/);
const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyRecord.subarray(10)]),
  type: "spki",
  format: "der",
});
for (const name of [nsis, msi, portable]) {
  const [, signatureLine, trustedComment, globalLine] = lines(read(name + ".sig"));
  const signatureRecord = Buffer.from(signatureLine, "base64");
  assert.equal(signatureRecord.length, 74, "Invalid signature record for " + name);
  assert.deepEqual(signatureRecord.subarray(2, 10), keyRecord.subarray(2, 10), "Wrong signing key for " + name);
  const algorithm = signatureRecord.toString("ascii", 0, 2);
  assert.match(algorithm, /^E[dD]$/);
  const message = algorithm === "ED" ? await hash(name, "blake2b512") : readFileSync(join(directory, name));
  const signature = signatureRecord.subarray(10);
  assert.ok(verify(null, message, key, signature), "Invalid updater signature for " + name);
  assert.ok(trustedComment.startsWith("trusted comment: "));
  const metadata = Buffer.concat([signature, Buffer.from(trustedComment.slice("trusted comment: ".length))]);
  assert.ok(verify(null, metadata, key, Buffer.from(globalLine, "base64")), "Invalid signed metadata for " + name);
}

for (const [list, required] of [
  ["SHA256SUMS", [nsis, msi, portable, executable]],
  ["CLI-SHA256SUMS", ["dbx-cli-win32-x64.zip"]],
  [executable + ".sha256", [executable]],
]) {
  const checksums = new Map(read(list).split(/\r?\n/).map((line) => line.split("  ")).map(([digest, name]) => [name, digest]));
  for (const name of required) assert.equal(checksums.get(name), (await hash(name)).toString("hex"), list + " " + name);
}
console.log("Verified DBX-Next " + tag + " feed, installer and portable signatures, and Desktop/CLI checksums.");
