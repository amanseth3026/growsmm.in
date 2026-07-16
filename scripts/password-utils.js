const PASSWORD_SCHEME = "pbkdf2-sha256-v1";
const PBKDF2_ITERATIONS = 120000;
const SALT_BYTE_LENGTH = 16;
const textEncoder = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Uint8Array();

  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomSaltBytes(length = SALT_BYTE_LENGTH) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

async function derivePasswordRecord(password, saltBytes = randomSaltBytes()) {
  const cryptoSubtle = globalThis.crypto?.subtle;
  if (!cryptoSubtle) {
    throw new Error("Password hashing is not available in this browser.");
  }

  const keyMaterial = await cryptoSubtle.importKey(
    "raw",
    textEncoder.encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await cryptoSubtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return {
    passwordHash: bytesToBase64(new Uint8Array(derivedBits)),
    passwordSalt: bytesToBase64(saltBytes),
    passwordScheme: PASSWORD_SCHEME,
    passwordUpdatedAt: Date.now()
  };
}

export async function createPasswordRecord(password) {
  const clean = String(password || "").trim();
  if (!clean) {
    return {
      passwordHash: "",
      passwordSalt: "",
      passwordScheme: PASSWORD_SCHEME,
      passwordUpdatedAt: Date.now()
    };
  }

  return derivePasswordRecord(clean);
}

export async function verifyPasswordRecord(password, userData = {}) {
  const clean = String(password || "").trim();
  if (!clean) return false;

  const passwordHash = String(userData.passwordHash || "").trim();
  const passwordSalt = String(userData.passwordSalt || "").trim();
  if (passwordHash && passwordSalt) {
    const candidate = await derivePasswordRecord(clean, base64ToBytes(passwordSalt));
    return candidate.passwordHash === passwordHash;
  }

  const legacyPassword = String(userData.password || "").trim();
  return !!legacyPassword && legacyPassword === clean;
}

export function hasSecurePasswordRecord(userData = {}) {
  return !!String(userData.passwordHash || "").trim() && !!String(userData.passwordSalt || "").trim();
}

export function hasPasswordRecord(userData = {}) {
  return hasSecurePasswordRecord(userData) || !!String(userData.password || "").trim();
}
