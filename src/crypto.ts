import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const SALT = Buffer.from('pulsebot-static-salt-01'); // OK for derivation; change if you rotate

function deriveKey(master: string) {
  return crypto.scryptSync(master, SALT, 32);
}

export function encryptPrivateKey(master: string, privKeyHex: string) {
  const key = deriveKey(master);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privKeyHex.replace(/^0x/, ''), 'hex')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptPrivateKey(master: string, blob: Buffer) {
  const key = deriveKey(master);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const data = blob.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return '0x' + plaintext.toString('hex');
}
