// Secrets at rest: AES-256-GCM encryption for exchange credentials stored in
// the database. The key lives only in the app's Secrets vault. Stored values
// are "enc1:<iv-b64>:<ciphertext-b64>"; anything without that prefix is
// treated as legacy plaintext and returned untouched, so existing
// connections keep working until they are re-saved.

import { secrets } from "base44:runtime";

const PREFIX = "enc1:";
const te = new TextEncoder();
const td = new TextDecoder();

let cachedKey = null;
let cachedSource = null;

async function getKey() {
  const secret = secrets.get("SECRET_ENCRYPTION_KEY") || "";
  if (!secret) throw new Error("SECRET_ENCRYPTION_KEY is not set");
  if (cachedKey && cachedSource === secret) return cachedKey;
  const material = await crypto.subtle.digest("SHA-256", te.encode(secret));
  cachedKey = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  cachedSource = secret;
  return cachedKey;
}

function toB64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plain) {
  const value = String(plain || "");
  if (!value) return "";
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(value));
  return `${PREFIX}${toB64(iv)}:${toB64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(stored) {
  const raw = String(stored || "");
  if (!raw.startsWith(PREFIX)) return raw;
  const [, ivB64, ctB64] = raw.split(":");
  if (!ivB64 || !ctB64) throw new Error("Stored secret is malformed");
  const key = await getKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    key,
    fromB64(ctB64),
  );
  return td.decode(plain);
}