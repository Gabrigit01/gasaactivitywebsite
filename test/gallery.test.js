import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { openDatabase } from '../database.js';
import { GalleryError, installGallery } from '../gallery.js';
import { localPostgres } from './postgres-helper.js';

const MIB = 1024 * 1024;
const roles = { owner: ['read', 'edit'], organizer: ['read', 'edit'], viewer: ['read'] };
function box(type, content = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, content]);
}
function mp4(size = 32) {
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1000, 12);
  movieHeader.writeUInt32BE(36_000_000, 16); // Ten hours: gallery archives have no short-film duration cap.
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'ascii')),
    box('moov', Buffer.concat([box('mvhd', movieHeader), box('trak', box('tkhd', Buffer.alloc(84)))])),
    box('mdat', Buffer.alloc(size, 7)),
  ]);
}

for (const dialect of ['sqlite', 'postgres']) {
  test('galerie persistante, confidentialité et lecture partielle sur ' + dialect, async t => {
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-gallery-')) : null;
    const database = dialect === 'postgres' ? await localPostgres() : await openDatabase({ connectionString: '', dataDir: directory });
    const chunks = [];
    const db = { ...database, prepare(sql) {
      const statement = database.prepare(sql);
      if (!sql.startsWith('SELECT substr(content,')) return statement;
      return { ...statement, async get(...values) { chunks.push(values); return statement.get(...values); } };
    } };
    await db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,announcement TEXT);
      CREATE TABLE gallery_test_actions (kind TEXT NOT NULL,actor TEXT NOT NULL,session_id TEXT NOT NULL,detail TEXT NOT NULL);
    `);
    for (const [id, title, status, announcement] of [
      ['published', 'Séance passée', 'published', null],
      ['draft', 'Séance confidentielle', 'draft', null],
      ['future', 'Surprise secrète', 'published', JSON.stringify({ mode: 'surprise', date: '2099-12-01T12:00:00.000Z' })],
      ['past', 'Événement passé', 'published', JSON.stringify({ mode: 'normal', date: '2020-01-01T12:00:00.000Z' })],
    ]) await db.prepare('INSERT INTO sessions (id,title,status,announcement) VALUES (?,?,?,?)').run(id, title, status, announcement);
    let server, origin, rejectAudit = false;
    const auth = {
      async admin(req) { const role = req.get('X-Role'); return roles[role] ? { username: role, role, capabilities: roles[role] } : null; },
      requireAdmin(capability) {
        return async (req, res, next) => {
          req.admin = await auth.admin(req);
          if (!req.admin) return res.status(401).json({ error: 'Connexion requise.' });
          if (!req.admin.capabilities.includes(capability)) return res.status(403).json({ error: 'Accès refusé.' });
          next();
        };
      },
    };
    const start = async () => {
      const app = express();
      app.disable('etag');
      const api = express.Router();
      app.use('/api', api);
      await installGallery({ app, api, db, auth, mutate: work => db.transaction(work), record: async event => {
        if (rejectAudit) throw new Error('Audit indisponible.');
        await db.prepare('INSERT INTO gallery_test_actions (kind,actor,session_id,detail) VALUES (?,?,?,?)')
          .run(event.kind, event.admin.username, event.session.id, event.detail);
      } });
      app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        res.status(error instanceof GalleryError ? error.status : 500).json({ error: error.message });
      });
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      origin = 'http://127.0.0.1:' + server.address().port;
    };
    const stop = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    t.after(async () => {
      if (server?.listening) await stop();
      await db.close();
      if (directory) {
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('gasa-gallery-'));
        await rm(target, { recursive: true, force: true });
      }
    });
    await start();
    const request = async (path, { role, method = 'GET', headers = {}, body } = {}) => {
      const response = await fetch(origin + path, { method, body, headers: { ...(role ? { 'X-Role': role } : {}), ...headers } });
      const data = response.headers.get('content-type')?.includes('application/json') && method !== 'HEAD'
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, data };
    };
    const photo = await sharp({ create: { width: 2500, height: 100, channels: 3, background: '#658e67' } })
      .jpeg().withMetadata().toBuffer();
    const video = mp4(2 * MIB + 17);
    const upload = (bytes = photo, { role = 'organizer', sessionId = 'published', title = 'Souvenir du campus', alt = 'Les étudiants réunis', mime = 'image/jpeg', extraFile = false } = {}) => {
      const form = new FormData();
      if (sessionId !== null) form.set('sessionId', sessionId);
      if (title !== null) form.set('title', title);
      if (alt !== null) form.set('alt', alt);
      form.append('file', new Blob([bytes], { type: mime }), mime === 'video/mp4' ? 'archive.mp4' : 'photo.jpg');
      if (extraFile) form.append('file', new Blob([bytes], { type: mime }), 'extra.jpg');
      return request('/api/admin/gallery', { role, method: 'POST', body: form });
    };
    const count = async () => Number((await db.prepare('SELECT COUNT(*) AS count FROM media_gallery').get()).count);
    const auditCount = async () => Number((await db.prepare('SELECT COUNT(*) AS count FROM gallery_test_actions').get()).count);
    let imageItem, videoItem, draftItem, futureItem;

    await t.test('permissions et normalisation de photo en WebP', async () => {
      assert.deepEqual((await request('/api/gallery')).data, { items: [] });
      assert.equal((await request('/api/admin/gallery')).status, 401);
      assert.equal((await request('/api/admin/gallery', { role: 'viewer' })).status, 200);
      assert.equal((await upload(photo, { role: null })).status, 401);
      assert.equal((await upload(photo, { role: 'viewer' })).status, 403);
      const uploaded = await upload();
      assert.equal(uploaded.status, 201);
      imageItem = uploaded.data;
      assert.equal(imageItem.sessionId, 'published');
      assert.equal(imageItem.sessionTitle, 'Séance passée');
      assert.equal(imageItem.type, 'image');
      assert.equal(imageItem.mimeType, 'image/webp');
      assert.equal(imageItem.publiclyVisible, true);
      assert.ok(imageItem.length > 0);
      assert.ok(Date.parse(imageItem.createdAt));
      const served = await request(imageItem.url);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/webp');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(served.headers.get('cache-control'), 'private, no-store');
      assert.equal(served.headers.get('content-length'), String(imageItem.length));
      const info = await sharp(served.data).metadata();
      assert.equal(info.format, 'webp');
      assert.equal(info.width, 2200);
      assert.ok(info.height <= 2200);
      assert.equal(info.exif, undefined);
      assert.equal(info.icc, undefined);
      assert.equal((await request('/api/gallery')).data.items.length, 1);
    });

    await t.test('MP4, ranges bornés, suffixes, HEAD et If-Range', async () => {
      const uploaded = await upload(video, { title: 'Archive vidéo', mime: 'video/mp4' });
      assert.equal(uploaded.status, 201);
      videoItem = uploaded.data;
      assert.equal(videoItem.mimeType, 'video/mp4');
      assert.equal(videoItem.type, 'video');
      assert.equal(videoItem.length, video.length);
      chunks.length = 0;
      const complete = await request(videoItem.url);
      assert.equal(complete.status, 200);
      assert.deepEqual(complete.data, video);
      assert.equal(chunks.length, 3);
      assert.ok(chunks.every(([, length]) => length <= MIB), 'les données sont lues par tranches SQL bornées');
      const cases = [
        ['bytes=0-7', 0, 7], ['bytes=8-', 8, video.length - 1],
        ['bytes=-8', video.length - 8, video.length - 1], ['bytes=0-999999999', 0, video.length - 1],
        ['bytes=1048572-1048580', 1048572, 1048580],
      ];
      for (const [range, start, end] of cases) {
        const partial = await request(videoItem.url, { headers: { Range: range } });
        assert.equal(partial.status, 206, range);
        assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
        assert.equal(partial.headers.get('content-length'), String(end - start + 1));
        assert.deepEqual(partial.data, video.subarray(start, end + 1));
      }
      for (const range of ['bytes=999999999-', 'bytes=8-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9007199254740992-']) {
        const invalid = await request(videoItem.url, { headers: { Range: range } });
        assert.equal(invalid.status, 416, range);
        assert.equal(invalid.headers.get('content-range'), 'bytes */' + video.length);
        assert.equal(invalid.data.length, 0);
      }
      const head = await request(videoItem.url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(video.length));
      assert.equal(head.data.length, 0);
      const headRange = await request(videoItem.url, { method: 'HEAD', headers: { Range: 'bytes=0-7' } });
      assert.equal(headRange.status, 206);
      assert.equal(headRange.headers.get('content-length'), '8');
      assert.equal(headRange.data.length, 0);
      assert.equal((await request(videoItem.url, { headers: { Range: 'bytes=0-7', 'If-Range': '"another-version"' } })).status, 200);
      assert.equal((await request(videoItem.url, { headers: { Range: 'bytes=0-7', 'If-Range': complete.headers.get('etag') } })).status, 206);
    });

    await t.test('séances privées et annonces futures sans fuite de médias', async () => {
      draftItem = (await upload(photo, { sessionId: 'draft', title: 'Photo privée' })).data;
      futureItem = (await upload(photo, { sessionId: 'future', title: 'Média surprise' })).data;
      const pastItem = (await upload(photo, { sessionId: 'past' })).data;
      const publicItems = (await request('/api/gallery')).data.items;
      assert.ok(publicItems.some(item => item.id === pastItem.id));
      assert.ok(!publicItems.some(item => ['draft', 'future'].includes(item.sessionId)));
      assert.ok(!JSON.stringify(publicItems).includes('secrète'));
      const adminItems = (await request('/api/admin/gallery', { role: 'viewer' })).data.items;
      assert.equal(adminItems.find(item => item.id === draftItem.id).publiclyVisible, false);
      assert.equal(adminItems.find(item => item.id === futureItem.id).publiclyVisible, false);
      for (const item of [draftItem, futureItem]) {
        assert.equal((await request(item.url)).status, 404);
        assert.equal((await request(item.url, { method: 'HEAD' })).status, 404);
        assert.equal((await request(item.url, { headers: { Range: 'bytes=0-7' } })).status, 404);
        assert.equal((await request(item.url, { role: 'viewer' })).status, 200);
      }
      await db.prepare('UPDATE sessions SET status=? WHERE id=?').run('published', 'draft');
      assert.equal((await request(draftItem.url)).status, 200);
      await db.prepare('UPDATE sessions SET status=? WHERE id=?').run('draft', 'draft');
      assert.equal((await request(draftItem.url)).status, 404, 'une dépublication bloque immédiatement les lectures');
      await db.prepare('UPDATE sessions SET announcement=? WHERE id=?').run(JSON.stringify({ mode: 'surprise', date: '2020-01-01T00:00:00.000Z' }), 'future');
      assert.equal((await request(futureItem.url)).status, 200);
      await db.prepare('UPDATE sessions SET announcement=? WHERE id=?').run('{invalid', 'future');
      assert.equal((await request(futureItem.url)).status, 404, 'une annonce illisible reste privée');
    });

    await t.test('fichiers invalides, limites, formulaire et quota', async () => {
      const before = await count();
      for (const [bytes, mime] of [
        [Buffer.alloc(0), 'image/jpeg'], [Buffer.from('<script>bad()</script>'), 'text/html'],
        [Buffer.from('not a JPEG'), 'image/jpeg'], [photo, 'image/png'],
        [Buffer.from('ftypmoovmdat'), 'video/mp4'], [box('ftyp', Buffer.from('isom\0\0\0\0', 'ascii')), 'video/mp4'],
        [video.subarray(0, video.length - 1), 'video/mp4'],
      ]) assert.equal((await upload(bytes, { mime })).status, 400);
      assert.equal((await upload(Buffer.concat([photo, Buffer.alloc(5 * MIB)]))).status, 413);
      if (dialect === 'sqlite') {
        assert.equal((await upload(Buffer.alloc(50 * MIB + 1), { mime: 'video/mp4' })).status, 413);
      }
      for (const options of [{ sessionId: null }, { sessionId: 'absent' }, { title: null }, { title: 'x'.repeat(161) }, { alt: 'x'.repeat(301) }, { title: 'A\nB' }, { extraFile: true }]) {
        assert.equal((await upload(photo, options)).status, options.sessionId === 'absent' ? 404 : 400);
      }
      assert.equal(await count(), before);
      for (let index = 0; index < 5; index++) {
        await db.prepare(`INSERT INTO media_gallery (id,session_id,title,alt,mime_type,type,content,length,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run('quota-' + index, 'draft', 'Quota', 'Quota', 'video/mp4', 'video', Buffer.from([0]), 50 * MIB, new Date().toISOString());
      }
      const full = await upload();
      assert.equal(full.status, 413);
      assert.match(full.data.error, /250 Mo/);
      assert.equal(await count(), before + 5);
      await db.prepare("DELETE FROM media_gallery WHERE id LIKE 'quota-%'").run();
      assert.equal((await request(imageItem.url)).status, 200);
    });

    await t.test('audits atomiques, suppression autorisée et persistance après redémarrage', async () => {
      const before = await count(), actionsBefore = await auditCount();
      rejectAudit = true;
      try {
        assert.equal((await upload()).status, 500);
        assert.equal(await count(), before, 'un audit refusé annule aussi les octets importés');
        assert.equal((await request(videoItem.url)).status, 200);
        assert.equal((await request('/api/admin/gallery/' + videoItem.id, { role: 'organizer', method: 'DELETE' })).status, 500);
        assert.equal((await request(videoItem.url)).status, 200, 'un audit refusé annule la suppression');
      } finally { rejectAudit = false; }
      assert.equal(await auditCount(), actionsBefore);
      assert.equal((await request('/api/admin/gallery/' + videoItem.id, { method: 'DELETE' })).status, 401);
      assert.equal((await request('/api/admin/gallery/' + videoItem.id, { role: 'viewer', method: 'DELETE' })).status, 403);
      await stop();
      await start();
      assert.equal(await count(), before);
      assert.deepEqual((await request(videoItem.url)).data, video);
      assert.equal((await request(draftItem.url)).status, 404);
      assert.equal((await request(futureItem.url)).status, 404);
      const deleted = await request('/api/admin/gallery/' + videoItem.id, { role: 'organizer', method: 'DELETE' });
      assert.equal(deleted.status, 200);
      assert.deepEqual(deleted.data, { ok: true });
      assert.equal((await request(videoItem.url)).status, 404);
      assert.equal((await request('/api/admin/gallery/' + videoItem.id, { role: 'organizer', method: 'DELETE' })).status, 404);
      assert.ok(!(await request('/api/gallery')).data.items.some(item => item.id === videoItem.id));
      const events = await db.prepare('SELECT * FROM gallery_test_actions').all();
      assert.ok(events.some(event => event.kind === 'admin.gallery-upload' && event.actor === 'organizer' && event.session_id === 'published'));
      assert.ok(events.some(event => event.kind === 'admin.gallery-delete' && event.detail === 'Archive vidéo'));
    });
  });
}
