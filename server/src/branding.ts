/**
 * Company branding: logo files and theme colour.
 * Logos are brand assets shown to candidates (portal, interview join page), so they are served from a public URL
 * keyed by company id with a version parameter for cache-busting. Only raster images are accepted (no SVG: it can carry script).
 */
import { Router } from 'express';
import fs from 'node:fs';
import multer from 'multer';
import { db, now, j } from './db.js';
import { wrap, HttpError, bad, notFound } from './util.js';
import { saveFile, safeKey, deleteFile, scanFile } from './services.js';

export const THEME_RE = /^#[0-9a-fA-F]{6}$/;
export const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

/** Public URL for a company's logo, or null. */
export const logoUrl = (c: any) => (c?.logo_key ? `/api/public/logo/${c.id}?v=${encodeURIComponent(c.logo_updated_at || '1')}` : null);
/** Theme colour (hex) chosen by the company, or null for the IntervueX default. */
export const themeOf = (c: any) => { const t = j<any>(c?.settings, {}).themeColor; return THEME_RE.test(t || '') ? String(t).toLowerCase() : null; };

function detectImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

/** Validates and stores a logo for a company, replacing any previous one. */
export async function storeLogo(companyId: string, file: Express.Multer.File | undefined) {
  if (!file) throw bad('Choose an image to upload');
  const kind = detectImage(file.buffer);
  if (!kind) throw new HttpError(415, 'The logo must be a PNG, JPG or WebP image (SVG is not accepted).', 'bad_image');
  await scanFile(file.buffer);
  const c = await db.companies.get({ id: companyId }); if (!c) throw notFound('Company not found');
  const key = saveFile(companyId, file.buffer, kind.ext);
  const at = now();
  await db.companies.set({ id: companyId }, { logo_key: key, logo_mime: kind.mime, logo_updated_at: at });
  if (c.logo_key) deleteFile(c.logo_key);
  return logoUrl({ ...c, logo_key: key, logo_updated_at: at });
}
export async function removeLogo(companyId: string) {
  const c = await db.companies.get({ id: companyId }); if (!c) throw notFound('Company not found');
  if (c.logo_key) deleteFile(c.logo_key);
  await db.companies.set({ id: companyId }, { logo_key: null, logo_mime: null, logo_updated_at: now() });
}

/** GET /api/public/logo/:companyId — public brand asset. */
export const logoRouter = Router();
logoRouter.get('/logo/:companyId', wrap(async (req, res) => {
  const c = await db.companies.get({ id: String(req.params.companyId) }, { projection: { logo_key: 1, logo_mime: 1 } });
  if (!c?.logo_key) throw notFound('No logo');
  res.setHeader('Content-Type', c.logo_mime || 'image/png');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  fs.createReadStream(safeKey(c.logo_key)).on('error', () => res.status(404).end()).pipe(res);
}));
