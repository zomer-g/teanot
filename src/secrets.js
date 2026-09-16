// API keys entered in the admin panel are stored encrypted (AES-256-GCM) under a master key that lives only
// in the environment, so a copy of the database alone does not reveal them.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const MIN_MASTER_CHARS = 32;

function masterKey() {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw || raw.length < MIN_MASTER_CHARS) return null;
  return Buffer.from(hkdfSync('sha256', raw, 'teanot', 'provider-api-keys', 32));
}

export const encryptionAvailable = () => masterKey() !== null;

export function encryptSecret(plain) {
  const key = masterKey();
  if (!key) throw new Error('encryption_unavailable');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: data.toString('base64') };
}

// Returns null when the master key is missing or changed, so a rotated key reads as "not configured"
// instead of crashing every request.
export function decryptSecret({ iv, tag, ciphertext }) {
  const key = masterKey();
  if (!key) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
