import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.paths.uploads),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files (jpeg, png, webp, gif) are accepted as evidence.'));
  },
});

/**
 * SHA-256 of the original uploaded bytes (PRD §9: "Evidence hashes must be calculated
 * from original uploaded bytes"). A hash establishes content integrity relative to a known
 * hash — it does not prove capture date or the truth of the photo's contents.
 */
export function hashUploadedFile(filename) {
  const buf = fs.readFileSync(path.join(config.paths.uploads, filename));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Detect the real image type from magic bytes — the client-supplied mimetype is not trusted. */
export function sniffImageType(filename) {
  const fd = fs.openSync(path.join(config.paths.uploads, filename), 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

export function removeUpload(filename) {
  try { fs.unlinkSync(path.join(config.paths.uploads, filename)); } catch { /* ignore */ }
}
