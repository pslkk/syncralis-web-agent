import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadOrCreateKeypair,
  signRequest,
  verifySignature,
  buildDirectoryDocument,
} from "../src/security/webBotAuth.js";

function freshDir() {
  return mkdtempSync(path.join(tmpdir(), "webbotauth-test-"));
}

test("loadOrCreateKeypair generates a usable Ed25519 keypair", () => {
  const dir = freshDir();
  try {
    const material = loadOrCreateKeypair(dir);
    assert.equal(typeof material.keyid, "string");
    assert.ok(material.keyid.length > 0);
    assert.ok(material.privateKeyPem.includes("BEGIN PRIVATE KEY"));
    assert.ok(material.publicKeyPem.includes("BEGIN PUBLIC KEY"));
    assert.ok(material.publicKeyBase64Url.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateKeypair persists the key to disk with owner-only permissions", () => {
  const dir = freshDir();
  try {
    loadOrCreateKeypair(dir);
    const keyPath = path.join(dir, "web-bot-auth-ed25519.json");
    const stats = statSync(keyPath);
    const mode = stats.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateKeypair returns the SAME key on a second call (persistence, not regeneration)", () => {
  const dir = freshDir();
  try {
    const first = loadOrCreateKeypair(dir);
    const second = loadOrCreateKeypair(dir);
    assert.equal(first.keyid, second.keyid);
    assert.equal(first.privateKeyPem, second.privateKeyPem);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateKeypair regenerates safely if the key file is corrupted", () => {
  const dir = freshDir();
  try {
    loadOrCreateKeypair(dir);
    const keyPath = path.join(dir, "web-bot-auth-ed25519.json");
    writeFileSync(keyPath, "{ not json", { mode: 0o600 });
    let failure = null;
    const material = loadOrCreateKeypair(dir, { onPersistFailure: (e) => (failure = e) });
    assert.equal(failure, null);
    assert.ok(material.keyid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signRequest + verifySignature round-trips successfully for a valid request", () => {
  const dir = freshDir();
  try {
    const material = loadOrCreateKeypair(dir);
    const headers = signRequest({
      method: "GET",
      url: "https://example.com/some/path?x=1",
      keyid: material.keyid,
      privateKeyPem: material.privateKeyPem,
      agentDirectoryUrl: "https://agent.example.org",
    });

    assert.match(headers["Signature-Input"], /^sig1=\(/);
    assert.match(headers["Signature"], /^sig1=:.+:$/);
    assert.equal(headers["Signature-Agent"], '"https://agent.example.org"');

    const result = verifySignature({
      method: "GET",
      url: "https://example.com/some/path?x=1",
      headers,
      publicKeyPem: material.publicKeyPem,
    });
    assert.equal(result.valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signRequest omits Signature-Agent when no directory URL is configured", () => {
  const dir = freshDir();
  try {
    const material = loadOrCreateKeypair(dir);
    const headers = signRequest({
      method: "GET",
      url: "https://example.com/",
      keyid: material.keyid,
      privateKeyPem: material.privateKeyPem,
    });
    assert.equal(headers["Signature-Agent"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifySignature rejects a signature verified against the WRONG public key", () => {
  const dirA = freshDir();
  const dirB = freshDir();
  try {
    const keyA = loadOrCreateKeypair(dirA);
    const keyB = loadOrCreateKeypair(dirB);
    const headers = signRequest({
      method: "GET",
      url: "https://example.com/x",
      keyid: keyA.keyid,
      privateKeyPem: keyA.privateKeyPem,
    });
    const result = verifySignature({
      method: "GET",
      url: "https://example.com/x",
      headers,
      publicKeyPem: keyB.publicKeyPem,
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "signature_mismatch");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("verifySignature rejects a signature replayed against a DIFFERENT method/path/authority", () => {
  const dir = freshDir();
  try {
    const material = loadOrCreateKeypair(dir);
    const headers = signRequest({
      method: "GET",
      url: "https://example.com/a",
      keyid: material.keyid,
      privateKeyPem: material.privateKeyPem,
    });
    const tamperedTarget = verifySignature({
      method: "GET",
      url: "https://example.com/b", // different path than what was signed
      headers,
      publicKeyPem: material.publicKeyPem,
    });
    assert.equal(tamperedTarget.valid, false);

    const tamperedMethod = verifySignature({
      method: "POST", // different method than what was signed
      url: "https://example.com/a",
      headers,
      publicKeyPem: material.publicKeyPem,
    });
    assert.equal(tamperedMethod.valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifySignature rejects an expired signature", () => {
  const dir = freshDir();
  try {
    const material = loadOrCreateKeypair(dir);
    const past = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const headers = signRequest({
      method: "GET",
      url: "https://example.com/x",
      keyid: material.keyid,
      privateKeyPem: material.privateKeyPem,
      now: past,
    });
    const result = verifySignature({
      method: "GET",
      url: "https://example.com/x",
      headers,
      publicKeyPem: material.publicKeyPem,
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, "expired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifySignature rejects malformed/missing signature headers", () => {
  const result = verifySignature({
    method: "GET",
    url: "https://example.com/",
    headers: {},
    publicKeyPem: "not a real key",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "malformed_signature_headers");
});

test("buildDirectoryDocument produces a JWK-set-shaped document with the public key", () => {
  const dir = freshDir();
  try {
    const material = loadOrCreateKeypair(dir);
    const doc = buildDirectoryDocument(material);
    assert.equal(doc.keys.length, 1);
    assert.equal(doc.keys[0].keyid, material.keyid);
    assert.equal(doc.keys[0].kty, "OKP");
    assert.equal(doc.keys[0].crv, "Ed25519");
    assert.equal(doc.keys[0].x, material.publicKeyBase64Url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
