import { randomUUID } from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';

const MIB = 1024 * 1024;
const IMAGE_LIMIT = 5 * MIB;
const VIDEO_LIMIT = 50 * MIB;
const STORAGE_LIMIT = 250 * MIB;
const CHUNK_SIZE = MIB;

export class GalleryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (condition, message, status = 400) => {
  if (!condition) throw new GalleryError(status, message);
};

function field(value, label, maximum, required = true) {
  need(typeof value === 'string' || (!required && value === undefined), `Renseignez ${label}.`);
  const text = (value || '').trim();
  need(!/[\u0000-\u001f\u007f-\u009f]/u.test(text), `${label} contient des caractères non autorisés.`);
  need(!required || text.length > 0, `Renseignez ${label}.`);
  need(text.length <= maximum, `${label} ne doit pas dépasser ${maximum} caractères.`);
  return text;
}

function boxAt(bytes, offset, end) {
  need(offset + 8 <= end, 'Le conteneur MP4 est incomplet.');
  let length = bytes.readUInt32BE(offset);
  let header = 8;
  if (length === 1) {
    need(offset + 16 <= end, 'Le conteneur MP4 est incomplet.');
    const large = bytes.readBigUInt64BE(offset + 8);
    need(large <= BigInt(Number.MAX_SAFE_INTEGER), 'La taille MP4 est invalide.');
    length = Number(large);
    header = 16;
  } else if (length === 0) length = end - offset;
  need(length >= header && offset + length <= end, 'La structure MP4 est invalide.');
  return { type: bytes.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + length, length, header };
}

// Inspect declared box boundaries, rather than searching inside arbitrary media bytes.
function validateMp4(bytes) {
  const first = boxAt(bytes, 0, bytes.length);
  need(first.type === 'ftyp' && first.length >= first.header + 8 && (first.length - first.header) % 4 === 0,
    'Choisissez un fichier MP4 valide.');
  const brands = [bytes.toString('ascii', first.start, first.start + 4)];
  for (let offset = first.start + 8; offset < first.end; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
  need(brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV)$/.test(brand)), 'Ce conteneur n’est pas un fichier MP4 pris en charge.');
  let movie = false, media = false;
  for (let offset = first.end; offset < bytes.length;) {
    const box = boxAt(bytes, offset, bytes.length);
    if (box.type === 'mdat') media ||= box.end > box.start;
    if (box.type === 'moov') {
      let header = false, track = false;
      for (let childOffset = box.start; childOffset < box.end;) {
        const child = boxAt(bytes, childOffset, box.end);
        if (child.type === 'mvhd') {
          const version = bytes[child.start];
          need((version === 0 || version === 1) && child.end - child.start >= (version === 1 ? 32 : 20),
            'Les métadonnées MP4 sont invalides.');
          const timescale = bytes.readUInt32BE(child.start + (version === 1 ? 20 : 12));
          need(timescale > 0, 'Les métadonnées MP4 sont invalides.');
          header = true;
        }
        if (child.type === 'trak') track = true;
        childOffset = child.end;
      }
      movie ||= header && track;
    }
    offset = box.end;
  }
  need(movie && media, 'Le MP4 doit contenir ses métadonnées et ses données vidéo.');
}

async function normalizeFile(file) {
  need(file?.buffer?.length > 0, 'Choisissez une photo ou une vidéo.');
  const bytes = file.buffer;
  if (file.mimetype === 'video/mp4') {
    need(bytes.length <= VIDEO_LIMIT, 'La vidéo MP4 ne doit pas dépasser 50 Mo.', 413);
    validateMp4(bytes);
    return { content: bytes, type: 'video', mimeType: 'video/mp4' };
  }
  need(['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype), 'Formats acceptés : JPEG, PNG, WebP et MP4.');
  need(bytes.length <= IMAGE_LIMIT, 'La photo ne doit pas dépasser 5 Mo.', 413);
  const mime = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  need(mime === file.mimetype, 'Le contenu du fichier ne correspond pas à une image autorisée.');
  try {
    const content = await sharp(bytes, { limitInputPixels: 24_000_000, failOn: 'warning' })
      .rotate().resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86 }).toBuffer();
    need(content.length <= IMAGE_LIMIT, 'L’image optimisée dépasse 5 Mo.', 413);
    return { content, type: 'image', mimeType: 'image/webp' };
  } catch (error) {
    if (error instanceof GalleryError) throw error;
    throw new GalleryError(400, 'Cette image est invalide ou trop grande. Choisissez une autre image.');
  }
}

function publiclyVisible(row) {
  if (row.session_status !== 'published') return false;
  if (!row.session_announcement) return true;
  try {
    const announcement = JSON.parse(row.session_announcement);
    if (!announcement) return true;
    const date = Date.parse(announcement.date);
    return Number.isFinite(date) && date <= Date.now();
  } catch { return false; }
}

function itemFromRow(row) {
  return {
    id: row.id, sessionId: row.session_id, sessionTitle: row.session_title,
    title: row.title, alt: row.alt, mimeType: row.mime_type, type: row.type,
    length: Number(row.length), createdAt: row.created_at, url: '/media/gallery/' + row.id,
    publiclyVisible: publiclyVisible(row),
  };
}

function byteRange(header, length) {
  if (!header) return { start: 0, end: length - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  const start = first === null ? Math.max(0, length - last) : first;
  const end = first === null ? length - 1 : last === null ? length - 1 : Math.min(last, length - 1);
  return start >= length || start < 0 || end < start || (first === null && last === 0)
    ? null : { start, end, partial: true };
}

export async function installGallery({ app, api, db, auth, mutate, record = async () => {} }) {
  const write = mutate || (work => db.transaction(work));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS media_gallery (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), title TEXT NOT NULL, alt TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp','video/mp4')),
      type TEXT NOT NULL CHECK (type IN ('image','video')), content BLOB NOT NULL,
      length INTEGER NOT NULL CHECK (length BETWEEN 1 AND 52428800), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_gallery_session ON media_gallery(session_id);
  `);
  const metadata = `SELECT media.id,media.session_id,media.title,media.alt,media.mime_type,media.type,media.length,media.created_at,
    session.title AS session_title,session.status AS session_status,session.announcement AS session_announcement
    FROM media_gallery media JOIN sessions session ON session.id=media.session_id`;
  const readItem = id => db.prepare(metadata + ' WHERE media.id=?').get(id);

  api.get('/gallery', async (req, res) => {
    const rows = await db.prepare(metadata + " WHERE session.status='published' ORDER BY media.created_at DESC,media.id DESC").all();
    res.json({ items: rows.filter(publiclyVisible).map(itemFromRow) });
  });
  api.get('/admin/gallery', auth.requireAdmin('read'), async (req, res) => {
    const rows = await db.prepare(metadata + ' ORDER BY media.created_at DESC,media.id DESC').all();
    res.json({ items: rows.map(itemFromRow) });
  });

  let uploadInProgress = false;
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: VIDEO_LIMIT, files: 1, fields: 3, fieldSize: 1200, parts: 4,
  } }).single('file');
  function receiveUpload(req, res, next) {
    if (uploadInProgress) {
      res.set('Retry-After', '2');
      return next(new GalleryError(429, 'Un média est en cours d’importation. Réessayez dans quelques secondes.'));
    }
    uploadInProgress = true;
    const release = () => { uploadInProgress = false; res.off('finish', release); res.off('close', release); };
    res.once('finish', release);
    res.once('close', release);
    upload(req, res, error => {
      if (!error) return next();
      release();
      next(new GalleryError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        error.code === 'LIMIT_FILE_SIZE' ? 'La vidéo ne doit pas dépasser 50 Mo ; la photo, 5 Mo.' : 'Le formulaire média est invalide. Envoyez un fichier et ses informations.'));
    });
  }

  api.post('/admin/gallery', auth.requireAdmin('edit'), receiveUpload, async (req, res) => {
    const sessionId = field(req.body?.sessionId, 'la séance', 80);
    const title = field(req.body?.title, 'le titre', 160);
    const alt = field(req.body?.alt, 'la description du média', 300, false) || title;
    const normalized = await normalizeFile(req.file);
    const item = await write(async () => {
      const session = await db.prepare('SELECT id,title FROM sessions WHERE id=?').get(sessionId);
      need(session, 'Cette séance est introuvable.', 404);
      // The shared mutation lock makes simultaneous uploads respect the same quota.
      const used = Number((await db.prepare('SELECT COALESCE(SUM(length),0) AS used FROM media_gallery').get()).used);
      need(used + normalized.content.length <= STORAGE_LIMIT,
        'La galerie a atteint sa limite de stockage de 250 Mo. Supprimez des médias avant d’en ajouter.', 413);
      const id = randomUUID();
      await db.prepare(`INSERT INTO media_gallery (id,session_id,title,alt,mime_type,type,content,length,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, sessionId, title, alt, normalized.mimeType, normalized.type,
        normalized.content, normalized.content.length, new Date().toISOString());
      await record({ kind: 'admin.gallery-upload', admin: req.admin, session, detail: title });
      return itemFromRow(await readItem(id));
    });
    res.status(201).json(item);
  });

  api.delete('/admin/gallery/:id', auth.requireAdmin('edit'), async (req, res) => {
    await write(async () => {
      const item = await readItem(req.params.id);
      need(item, 'Ce média est introuvable.', 404);
      await db.prepare('DELETE FROM media_gallery WHERE id=?').run(item.id);
      await record({ kind: 'admin.gallery-delete', admin: req.admin,
        session: { id: item.session_id, title: item.session_title }, detail: item.title });
    });
    res.json({ ok: true });
  });

  app.get('/media/gallery/:id', async (req, res) => {
    need(/^[a-f0-9-]{36}$/.test(req.params.id), 'Ce média est introuvable.', 404);
    const item = await readItem(req.params.id);
    need(item, 'Ce média est introuvable.', 404);
    if (!publiclyVisible(item)) {
      const admin = auth.admin ? await auth.admin(req, res) : null;
      need(admin, 'Ce média est introuvable.', 404);
    }
    const length = Number(item.length);
    const etag = '"' + item.id + '-' + length + '"';
    const modified = new Date(item.created_at).toUTCString();
    const ifRange = req.get('If-Range');
    const rangeHeader = !ifRange || ifRange === etag || ifRange === modified ? req.get('Range') : undefined;
    const range = byteRange(rangeHeader, length);
    res.set({
      'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', Vary: 'Cookie',
      'Content-Type': item.mime_type, 'X-Content-Type-Options': 'nosniff', ETag: etag,
      'Last-Modified': modified, 'Content-Disposition': `inline; filename="${item.id}.${item.type === 'video' ? 'mp4' : 'webp'}"`,
    });
    if (!range) return res.status(416).set({ 'Content-Range': 'bytes */' + length, 'Content-Length': '0' }).end();
    const { start, end, partial } = range;
    res.status(partial ? 206 : 200).set('Content-Length', String(end - start + 1));
    if (partial) res.set('Content-Range', `bytes ${start}-${end}/${length}`);
    if (req.method === 'HEAD') return res.end();
    for (let offset = start; offset <= end && !res.destroyed; offset += CHUNK_SIZE) {
      const count = Math.min(CHUNK_SIZE, end - offset + 1);
      const row = await db.prepare('SELECT substr(content,?,?) AS content FROM media_gallery WHERE id=?')
        .get(offset + 1, count, item.id);
      const chunk = row && Buffer.from(row.content);
      if (!chunk || chunk.length !== count) { res.destroy(); return; }
      if (!res.write(chunk)) {
        await new Promise(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    }
    res.end();
  });
}
