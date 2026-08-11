import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";

const SIGNATURE_ALGORITHM = "ed25519";
const SIGNATURE_LABEL = "sig1";
const CLOCK_SKEW_TOLERANCE_SECONDS = 300;

function generateKeypairMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const rawPublicKey = publicKeyDer.subarray(publicKeyDer.length - 32);
  const keyid = createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
  return {
    keyid,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    publicKeyBase64Url: rawPublicKey.toString("base64url"),
    createdAt: new Date().toISOString(),
  };
}

export function loadOrCreateKeypair(keyDir, { onPersistFailure } = {}) {
  const keyPath = path.join(keyDir, "web-bot-auth-ed25519.json");

  if (existsSync(keyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(keyPath, "utf8"));
      if (parsed?.keyid && parsed?.privateKeyPem && parsed?.publicKeyPem && parsed?.publicKeyBase64Url) {
        return parsed;
      }
    } catch {
      // Fall through and regenerate — a corrupted key file must never crash the server or silently disable signing forever.
    }
  }

  const material = generateKeypairMaterial();
  try {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${keyPath}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(material, null, 2), { mode: 0o600 });
    renameSync(tmpPath, keyPath);
  } catch (err) {
    onPersistFailure?.(err);
  }
  return material;
}

export function signRequest({ method, url, keyid, privateKeyPem, agentDirectoryUrl, now = new Date() }) {
  const target = new URL(url);
  const created = Math.floor(now.getTime() / 1000);
  const expires = created + CLOCK_SKEW_TOLERANCE_SECONDS;
  const nonce = randomBytes(16).toString("base64url");

  const signatureParams =
    `("@method" "@authority" "@path");created=${created};expires=${expires};` +
    `keyid="${keyid}";alg="${SIGNATURE_ALGORITHM}";nonce="${nonce}"`;

  const signatureBase = buildSignatureBase({ method, target, signatureParams });

  const privateKey = createPrivateKey(privateKeyPem);
  const signatureBytes = cryptoSign(null, Buffer.from(signatureBase, "utf8"), privateKey);

  return {
    "Signature-Input": `${SIGNATURE_LABEL}=${signatureParams}`,
    Signature: `${SIGNATURE_LABEL}=:${signatureBytes.toString("base64")}:`,
    ...(agentDirectoryUrl ? { "Signature-Agent": `"${agentDirectoryUrl}"` } : {}),
  };
}


function buildSignatureBase({ method, target, signatureParams }) {
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@authority": ${target.host}`,
    `"@path": ${target.pathname || "/"}`,
    `"@signature-params": ${signatureParams}`,
  ].join("\n");
}

export function verifySignature({ method, url, headers, publicKeyPem, now = new Date() }) {
  const signatureInputHeader = headers["Signature-Input"] || "";
  const signatureHeader = headers["Signature"] || "";

  const inputMatch = signatureInputHeader.match(/^sig1=(.+)$/);
  const sigMatch = signatureHeader.match(/^sig1=:(.+):$/);
  if (!inputMatch || !sigMatch) return { valid: false, reason: "malformed_signature_headers" };

  const signatureParams = inputMatch[1];
  const createdMatch = signatureParams.match(/created=(\d+)/);
  const expiresMatch = signatureParams.match(/expires=(\d+)/);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  if (expiresMatch && nowSeconds > Number(expiresMatch[1])) {
    return { valid: false, reason: "expired" };
  }
  if (createdMatch && Number(createdMatch[1]) > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
    return { valid: false, reason: "created_in_future" };
  }

  const target = new URL(url);
  const signatureBase = buildSignatureBase({ method, target, signatureParams });
  const publicKey = createPublicKey(publicKeyPem);
  const signatureBytes = Buffer.from(sigMatch[1], "base64");

  const valid = cryptoVerify(null, Buffer.from(signatureBase, "utf8"), publicKey, signatureBytes);
  return valid ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

export function buildDirectoryDocument({ keyid, publicKeyBase64Url, createdAt }) {
  return {
    keys: [
      {
        keyid,
        alg: SIGNATURE_ALGORITHM,
        kty: "OKP",
        crv: "Ed25519",
        x: publicKeyBase64Url,
        created: createdAt,
      },
    ],
  };
}
