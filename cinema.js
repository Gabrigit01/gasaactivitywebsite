import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AccountError } from './accounts.js';

const MAX_DURATION = 30 * 60;
const MAX_METADATA = 2 * 1024 * 1024;
const RANGE_SIZE = 64 * 1024;
const MAX_REQUESTS = 12;
const PROBE_TIMEOUT = 12_000;

function reject(message, status = 400) {
  throw new AccountError(status, message);
}

function checkedUrl(value, label, { video = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) reject(label + ' invalide.');
  let url;
  try { url = new URL(value.trim()); } catch { reject(label + ' invalide.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    reject(label + ' doit être une adresse HTTPS publique sans identifiants.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || (isIP(hostname) && !isPublicAddress(hostname))) reject(label + ' doit être publique.');
  if (video && !/\.mp4$/i.test(url.pathname)) reject('Indiquez l’URL directe d’un fichier MP4, terminant par .mp4.');
  if (video) url.hash = '';
  return url;
}

// Only globally routable addresses may be contacted. IPv4-mapped IPv6 and
// transition networks are rejected too, so they cannot conceal a private host.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 0 || b === 2 || b === 168))
      && !(a === 198 && (b === 18 || b === 19 || b === 51))
      && !(a === 203 && b === 0);
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(':')[0], 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  const lower = address.toLowerCase();
  return !lower.startsWith('2001:') && !lower.startsWith('2002:') && !lower.startsWith('3fff:');
}

function boxAt(buffer, offset, end) {
  if (offset + 8 > end) reject('Métadonnées MP4 incomplètes.');
  let size = buffer.readUInt32BE(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) reject('Métadonnées MP4 incomplètes.');
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) reject('Taille MP4 invalide.');
    size = Number(large);
    header = 16;
  } else if (size === 0) size = end - offset;
  if (size < header || offset + size > end) reject('Structure MP4 invalide.');
  return { type: buffer.toString('ascii', offset + 4, offset + 8), size, header };
}

function headerDuration(buffer, start, end) {
  if (start + 4 > end) reject('Durée MP4 absente.');
  const version = buffer[start];
  if (version !== 0 && version !== 1) reject('Version de métadonnées MP4 inconnue.');
  const scaleOffset = start + (version === 1 ? 20 : 12);
  const durationOffset = scaleOffset + 4;
  if (durationOffset + (version === 1 ? 8 : 4) > end) reject('Durée MP4 incomplète.');
  const scale = buffer.readUInt32BE(scaleOffset);
  const ticks = version === 1 ? buffer.readBigUInt64BE(durationOffset) : BigInt(buffer.readUInt32BE(durationOffset));
  if (!scale || !ticks || ticks === 0xffffffffn || ticks === 0xffffffffffffffffn
    || ticks > BigInt(Number.MAX_SAFE_INTEGER)) reject('La durée MP4 ne peut pas être vérifiée.');
  return Number(ticks) / scale;
}

// Parse boxes at their declared boundaries; searching for a bare "mvhd" marker
// would allow media bytes or forged metadata to be mistaken for a movie header.
export function parseMp4Duration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_METADATA) reject('Métadonnées MP4 trop volumineuses.');
  let movie = null;
  let movieHeader = null;
  let longestTrack = 0;
  let boxes = 0;
  function walk(start, end, context, depth = 0) {
    if (depth > 4) reject('Structure MP4 trop complexe.');
    for (let cursor = start; cursor < end;) {
      if (++boxes > 4096) reject('Structure MP4 trop complexe.');
      const box = boxAt(buffer, cursor, end);
      const body = cursor + box.header;
      const stop = cursor + box.size;
      if (context === 'root' && box.type === 'moov') {
        if (movie !== null) reject('Métadonnées MP4 ambiguës.');
        movie = cursor;
        walk(body, stop, 'moov', depth + 1);
      } else if (context === 'moov' && box.type === 'mvhd') {
        if (movieHeader !== null) reject('Durée MP4 ambiguë.');
        movieHeader = headerDuration(buffer, body, stop);
      } else if (context === 'moov' && box.type === 'trak') {
        walk(body, stop, 'trak', depth + 1);
      } else if (context === 'trak' && box.type === 'mdia') {
        walk(body, stop, 'mdia', depth + 1);
      } else if (context === 'mdia' && box.type === 'mdhd') {
        longestTrack = Math.max(longestTrack, headerDuration(buffer, body, stop));
      }
      cursor = stop;
    }
  }
  walk(0, buffer.length, 'root');
  if (movie === null || movieHeader === null) reject('Le fichier MP4 ne contient pas de durée vérifiable.');
  const seconds = Math.max(movieHeader, longestTrack);
  if (!(seconds > 0) || seconds > MAX_DURATION) reject('L’extrait doit durer au maximum 30 minutes.');
  return Math.ceil(seconds);
}

async function publicDestination(url, lookup, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    let abort;
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise((_resolve, rejectAbort) => {
          abort = () => rejectAbort(new Error('timeout'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } catch { reject('Impossible de vérifier l’hébergement du MP4.'); }
    finally { signal.removeEventListener('abort', abort); }
  }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    reject('L’hébergement MP4 doit utiliser uniquement des adresses Internet publiques.');
  }
  return addresses[0];
}

// DNS is resolved and checked once, then pinned in the socket lookup. Native
// fetch after a separate DNS check would resolve again and permit DNS rebinding.
export function downloadMp4Range(url, start, end, { destination, signal, requestFactory = httpsRequest }) {
  return new Promise((resolve, fail) => {
    const request = requestFactory(url, {
      agent: false,
      signal,
      headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity', Accept: 'video/mp4' },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [destination]);
        else callback(null, destination.address, destination.family);
      },
    }, response => {
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
      const encoding = response.headers['content-encoding'];
      if (response.statusCode !== 206 || !contentRange || (encoding && encoding !== 'identity')) {
        response.destroy();
        fail(new Error('Le serveur MP4 doit permettre la lecture partielle HTTP Range sans redirection.'));
        return;
      }
      const [actualStart, actualEnd, total] = contentRange.slice(1).map(Number);
      if (![actualStart, actualEnd, total].every(Number.isSafeInteger) || actualStart !== start
        || actualEnd !== Math.min(end, total - 1) || total <= 0 || actualEnd < start) {
        response.destroy();
        fail(new Error('Réponse de lecture partielle MP4 invalide.'));
        return;
      }
      const expected = actualEnd - start + 1;
      if (Number(response.headers['content-length'] ?? expected) !== expected) {
        response.destroy();
        fail(new Error('Taille de réponse MP4 invalide.'));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > expected) {
          response.destroy(new Error('Réponse MP4 trop volumineuse.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (length !== expected) return fail(new Error('Réponse MP4 interrompue.'));
        resolve({ buffer: Buffer.concat(chunks, length), total });
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('Délai de lecture MP4 dépassé.')));
    request.on('error', fail);
    request.end();
  });
}

export async function probeMp4Duration(value, { lookup = dnsLookup, readRange = downloadMp4Range } = {}) {
  const url = checkedUrl(value, 'L’URL de l’extrait', { video: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  timer.unref();
  let calls = 0;
  let bytes = 0;
  let total = null;
  try {
    const destination = await publicDestination(url, lookup, controller.signal);
    async function read(start, length) {
      if (++calls > MAX_REQUESTS || length > MAX_METADATA || bytes + length > MAX_METADATA + RANGE_SIZE * 3) {
        reject('Métadonnées MP4 trop volumineuses ou trop dispersées.');
      }
      const result = await readRange(url, start, total === null ? start + length - 1 : Math.min(start + length - 1, total - 1), {
        destination, signal: controller.signal,
      });
      if (!Number.isSafeInteger(result.total) || result.total < 8 || (total !== null && result.total !== total)) {
        reject('Le fichier MP4 a changé pendant sa vérification.');
      }
      if (!Buffer.isBuffer(result.buffer) || result.buffer.length !== Math.min(length, result.total - start)) {
        reject('Réponse de lecture partielle MP4 invalide.');
      }
      total = result.total;
      bytes += result.buffer.length;
      return result.buffer;
    }
    let cache = await read(0, RANGE_SIZE);
    let cacheStart = 0;
    let cursor = 0;
    let ftyp = false;
    let movie = null;
    let hasMedia = false;
    for (let boxes = 0; cursor < total; boxes++) {
      if (boxes > 256 || total - cursor < 8) reject('Structure MP4 invalide ou trop complexe.');
      if (cursor < cacheStart || cursor + Math.min(16, total - cursor) > cacheStart + cache.length) {
        cache = await read(cursor, RANGE_SIZE);
        cacheStart = cursor;
      }
      const local = cursor - cacheStart;
      const type = cache.toString('ascii', local + 4, local + 8);
      let size = cache.readUInt32BE(local);
      let header = 8;
      if (size === 1) {
        if (local + 16 > cache.length) reject('En-tête MP4 incomplet.');
        const big = cache.readBigUInt64BE(local + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) reject('Taille MP4 invalide.');
        size = Number(big);
        header = 16;
      } else if (size === 0) size = total - cursor;
      if (size < header || cursor + size > total) reject('Structure MP4 invalide.');
      if (cursor === 0 && type !== 'ftyp') reject('L’URL doit désigner un fichier MP4 standard.');
      if (type === 'ftyp') ftyp = true;
      if (type === 'mdat') hasMedia = true;
      if (type === 'moof') reject('Les MP4 fragmentés ne sont pas pris en charge. Exportez un MP4 standard.');
      if (type === 'moov') {
        if (movie || size > MAX_METADATA) reject('Métadonnées MP4 ambiguës ou trop volumineuses.');
        const data = cursor + size <= cacheStart + cache.length
          ? cache.subarray(local, local + size) : await read(cursor, size);
        movie = parseMp4Duration(data);
      }
      cursor += size;
    }
    if (!ftyp || !hasMedia || !movie) reject('Le fichier MP4 ne contient pas de vidéo vérifiable.');
    return movie;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    reject('Impossible de vérifier ce MP4. Utilisez un fichier public accessible en HTTP Range, sans redirection.');
  } finally { clearTimeout(timer); }
}

function cinemaFromRow(row) {
  return row ? {
    title: row.title, clipUrl: row.clip_url, durationSeconds: Number(row.duration_seconds),
    fullUrl: row.full_url || '', enabled: Boolean(row.enabled), updatedAt: Number(row.updated_at),
  } : null;
}

function announcementAllowsPlayback(value) {
  if (!value) return true;
  try {
    const announcement = JSON.parse(value);
    if (!announcement || typeof announcement !== 'object' || Array.isArray(announcement)
      || typeof announcement.date !== 'string') return false;
    const date = Date.parse(announcement.date);
    return Number.isFinite(date) && date <= Date.now();
  } catch { return false; }
}

export async function installCinema({
  api, db, auth, publicOrigin, probe = probeMp4Duration,
  mutate = work => db.transaction(work), onChange = async () => {},
}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS cinema_followups (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    clip_url TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 0 AND 1800),
    full_url TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at INTEGER NOT NULL
  );`);

  async function readForSession(sessionId) {
    return cinemaFromRow(await db.prepare('SELECT * FROM cinema_followups WHERE session_id = ?').get(sessionId));
  }

  async function validateCinema(input) {
    if (input === null) return null;
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject('Configuration cinéma invalide.');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') reject('Activation cinéma invalide.');
    const enabled = input.enabled !== false;
    if (!enabled && !String(input.clipUrl || '').trim()) return null;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 180) reject('Le titre de l’extrait doit contenir de 1 à 180 caractères.');
    const clipUrl = checkedUrl(input.clipUrl, 'L’URL de l’extrait', { video: true }).href;
    const fullUrl = input.fullUrl ? checkedUrl(input.fullUrl, 'Le lien du film intégral').href : '';
    // The client duration is deliberately ignored, including when the admin
    // supplies a shorter value than the actual hosted movie.
    const durationSeconds = enabled ? await probe(clipUrl) : 0;
    return { title, clipUrl, durationSeconds, fullUrl, enabled };
  }

  async function persistCinema(sessionId, cinema) {
    if (cinema === null) {
      await db.prepare('DELETE FROM cinema_followups WHERE session_id = ?').run(sessionId);
      return null;
    }
    await db.prepare(`INSERT INTO cinema_followups
      (session_id, title, clip_url, duration_seconds, full_url, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET
        title=excluded.title, clip_url=excluded.clip_url, duration_seconds=excluded.duration_seconds,
        full_url=excluded.full_url, enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(sessionId, cinema.title, cinema.clipUrl, cinema.durationSeconds, cinema.fullUrl,
        Number(cinema.enabled), Date.now());
    return readForSession(sessionId);
  }

  async function saveForSession(sessionId, input) {
    const session = await db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) reject('Séance introuvable.', 404);
    return persistCinema(sessionId, await validateCinema(input));
  }

  api.get('/cinema', async (_req, res) => {
    const rows = await db.prepare(`SELECT c.*, s.title AS session_title, s.announcement AS session_announcement FROM cinema_followups c
      JOIN sessions s ON s.id = c.session_id WHERE c.enabled = 1 AND s.status = 'published'
      ORDER BY c.updated_at DESC`).all();
    res.set('Cache-Control', 'no-store').json({ items: rows.filter(row => announcementAllowsPlayback(row.session_announcement)).map(row => ({
      sessionId: row.session_id, title: row.title, sessionTitle: row.session_title,
      durationSeconds: Number(row.duration_seconds), available: true,
      ...(row.full_url ? { fullUrl: row.full_url } : {}),
    })) });
  });

  api.get('/sessions/:id/cinema', auth.requireStudent, async (req, res) => {
    const session = await db.prepare("SELECT id, announcement FROM sessions WHERE id = ? AND status = 'published'").get(req.params.id);
    if (!session || !announcementAllowsPlayback(session.announcement)) reject('Cet extrait n’est pas disponible.', 404);
    const cinema = await readForSession(session.id);
    if (!cinema?.enabled) reject('Cet extrait n’est pas disponible.', 404);
    res.set('Cache-Control', 'private, no-store').json({ cinema });
  });

  api.post('/admin/sessions/:id/cinema', auth.requireAdmin('edit'), async (req, res) => {
    const input = Object.hasOwn(req.body || {}, 'cinema') ? req.body.cinema : req.body;
    const validated = await validateCinema(input);
    const cinema = await mutate(async () => {
      const session = await db.prepare('SELECT id, title, status FROM sessions WHERE id = ?').get(req.params.id);
      if (!session) reject('Séance introuvable.', 404);
      if (session.status === 'archived' && req.admin?.role !== 'owner'
        && !req.admin?.capabilities?.includes('archive')) {
        reject('Cette action est réservée au responsable du comité.', 403);
      }
      const saved = await persistCinema(session.id, validated);
      await onChange({ kind: 'admin.cinema-update', admin: req.admin,
        session: { id: session.id, title: session.title },
        detail: saved ? `${saved.title} · ${saved.enabled ? 'activé' : 'désactivé'}` : 'Extrait retiré' });
      return saved;
    });
    res.json({ cinema });
  });

  return { readForSession, saveForSession, validateCinema, persistCinema };
}
