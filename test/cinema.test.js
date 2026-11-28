import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.js';
import { localPostgres } from './postgres-helper.js';
import { downloadMp4Range, installCinema, isPublicAddress, parseMp4Duration, probeMp4Duration } from '../cinema.js';

function box(type, payload = Buffer.alloc(0), { large = false } = {}) {
  const header = Buffer.alloc(large ? 16 : 8);
  header.writeUInt32BE(large ? 1 : header.length + payload.length);
  header.write(type, 4);
  if (large) header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function durationHeader(type, seconds, version = 0) {
  const payload = Buffer.alloc(version === 1 ? 32 : 20);
  payload[0] = version;
  const scaleOffset = version === 1 ? 20 : 12;
  payload.writeUInt32BE(1000, scaleOffset);
  if (version === 1) payload.writeBigUInt64BE(BigInt(Math.round(seconds * 1000)), scaleOffset + 4);
  else payload.writeUInt32BE(Math.round(seconds * 1000), scaleOffset + 4);
  return box(type, payload);
}

function movie(seconds, { version = 0, trackSeconds, large = false } = {}) {
  return box('moov', Buffer.concat([
    durationHeader('mvhd', seconds, version),
    ...(trackSeconds === undefined ? [] : [box('trak', box('mdia', durationHeader('mdhd', trackSeconds, version)))]),
  ]), { large });
}

function sparseMovie(seconds, options) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isommp42'));
  const metadata = movie(seconds, options);
  const mediaSize = 100 * 1024 * 1024;
  const mediaHeader = Buffer.alloc(8);
  mediaHeader.writeUInt32BE(mediaSize);
  mediaHeader.write('mdat', 4);
  const metadataOffset = ftyp.length + mediaSize;
  const total = metadataOffset + metadata.length;
  const regions = [[0, ftyp], [ftyp.length, mediaHeader], [metadataOffset, metadata]];
  const requests = [];
  return {
    requests,
    readRange: async (url, start, end, options) => {
      requests.push({ url, start, end, options });
      const stop = Math.min(end + 1, total);
      const buffer = Buffer.alloc(stop - start);
      for (const [offset, data] of regions) {
        const left = Math.max(start, offset);
        const right = Math.min(stop, offset + data.length);
        if (right > left) data.copy(buffer, left - start, left - offset, right - offset);
      }
      return { buffer, total };
    },
  };
}

const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];

test('MP4: durées mvhd v0/v1, taille étendue, piste et limite exacte', () => {
  assert.equal(parseMp4Duration(movie(1500)), 1500);
  assert.equal(parseMp4Duration(movie(1800, { version: 1, large: true })), 1800);
  assert.equal(parseMp4Duration(movie(1499.3)), 1500);
  assert.equal(parseMp4Duration(movie(1500, { trackSeconds: 1550 })), 1550);
  assert.throws(() => parseMp4Duration(movie(1800.001)), /30 minutes/);
  assert.throws(() => parseMp4Duration(movie(600, { trackSeconds: 7200 })), /30 minutes/);
});

test('MP4: rejette faux marqueurs, structure tronquée et métadonnées ambiguës', () => {
  assert.throws(() => parseMp4Duration(box('mdat', movie(120))), /durée vérifiable/);
  assert.throws(() => parseMp4Duration(movie(0)), /durée/);
  assert.throws(() => parseMp4Duration(movie(100).subarray(0, 20)), /Structure/);
  assert.throws(() => parseMp4Duration(Buffer.concat([movie(100), movie(100)])), /ambiguës/);
  assert.throws(() => parseMp4Duration(box('moov', Buffer.concat([
    durationHeader('mvhd', 100), durationHeader('mvhd', 100),
  ]))), /ambiguë/);
  const unbounded = durationHeader('mvhd', 100);
  unbounded.writeUInt32BE(0, 8 + 12);
  assert.throws(() => parseMp4Duration(box('moov', unbounded)), /vérifiée/);
});

test('adresses réseau privées, réservées et tunnels interdits', () => {
  for (const value of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '2002:7f00:1::', '3fff::1', 'not-an-address']) {
    assert.equal(isPublicAddress(value), false, value);
  }
  for (const value of ['8.8.8.8', '93.184.215.14', '2606:4700:4700::1111', '2a00:1450::1']) {
    assert.equal(isPublicAddress(value), true, value);
  }
});

test('sonde: saute les données du film et lit moov placé après 100 Mo sans téléchargement intégral', async () => {
  const fixture = sparseMovie(1750, { version: 1 });
  let lookups = 0;
  const duration = await probeMp4Duration('https://media.example.test/suite.mp4?signature=ok', {
    lookup: async () => {
      lookups += 1;
      return lookups === 1 ? publicLookup() : [{ address: '127.0.0.1', family: 4 }];
    },
    readRange: fixture.readRange,
  });
  assert.equal(duration, 1750);
  assert.equal(lookups, 1, 'le DNS est résolu une seule fois puis épinglé');
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.reduce((sum, request) => sum + request.end - request.start + 1, 0) < 128 * 1024);
  assert.ok(fixture.requests[1].start > 100_000_000);
  assert.ok(fixture.requests.every(request => request.options.destination.address === '93.184.215.14'));
});

test('sonde: refuse URL dangereuses et DNS publics/privés mixtes avant toute lecture', async () => {
  let reads = 0;
  const readRange = async () => { reads += 1; throw new Error('unexpected'); };
  for (const url of ['http://example.test/file.mp4', 'https://localhost/file.mp4', 'https://127.1/file.mp4',
    'https://[::ffff:127.0.0.1]/file.mp4', 'https://user:secret@example.test/file.mp4',
    'https://example.test:8443/file.mp4', 'https://example.test/watch?v=video']) {
    await assert.rejects(probeMp4Duration(url, { lookup: publicLookup, readRange }));
  }
  await assert.rejects(probeMp4Duration('https://media.example.test/file.mp4', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], readRange,
  }), /publiques/);
  assert.equal(reads, 0);
});

test('sonde: refuse fichiers modifiés, réponses hors limites, film trop long et erreur/redirection réseau', async () => {
  const longFilm = sparseMovie(7200);
  await assert.rejects(probeMp4Duration('https://media.example.test/file.mp4', {
    lookup: publicLookup, readRange: longFilm.readRange,
  }), /30 minutes/);
  const changing = sparseMovie(1500);
  let requests = 0;
  await assert.rejects(probeMp4Duration('https://media.example.test/file.mp4', {
    lookup: publicLookup,
    readRange: async (...args) => {
      const result = await changing.readRange(...args);
      if (++requests > 1) result.total += 1;
      return result;
    },
  }), /changé/);
  await assert.rejects(probeMp4Duration('https://media.example.test/file.mp4', {
    lookup: publicLookup, readRange: async () => ({ total: 100_000, buffer: Buffer.alloc(70_000) }),
  }), /partielle/);
  await assert.rejects(probeMp4Duration('https://media.example.test/file.mp4', {
    lookup: publicLookup, readRange: async () => { throw new Error('302 redirect to private server'); },
  }), /sans redirection/);
});

test('transport HTTPS: épingle la résolution et refuse redirections, encodage et dépassement de réponse', async () => {
  const destination = { address: '93.184.215.14', family: 4 };
  let captured;
  const transfer = ({ status = 206, headers = {}, chunks = [Buffer.from('12345678')] } = {}) => {
    const requestFactory = (url, options, callback) => {
      captured = { url, options };
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = { 'content-range': 'bytes 0-7/100', ...headers };
        response.destroy = error => {
          response.destroyed = true;
          if (error) response.emit('error', error);
        };
        callback(response);
        for (const chunk of chunks) if (!response.destroyed) response.emit('data', chunk);
        if (!response.destroyed) response.emit('end');
      };
      return request;
    };
    return downloadMp4Range(new URL('https://media.example.test/film.mp4'), 0, 7, {
      destination, signal: new AbortController().signal, requestFactory,
    });
  };
  assert.equal((await transfer()).buffer.toString(), '12345678');
  assert.equal(captured.options.agent, false);
  assert.equal(captured.options.headers.Range, 'bytes=0-7');
  captured.options.lookup('media.example.test', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, destination.address);
    assert.equal(family, 4);
  });
  captured.options.lookup('media.example.test', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [destination]);
  });
  await assert.rejects(transfer({ status: 302, headers: { location: 'https://127.0.0.1/private.mp4' } }), /sans redirection/);
  await assert.rejects(transfer({ status: 200 }), /HTTP Range/);
  await assert.rejects(transfer({ headers: { 'content-encoding': 'gzip' } }), /HTTP Range/);
  await assert.rejects(transfer({ headers: { 'content-range': 'bytes 0-8/100' } }), /invalide/);
  await assert.rejects(transfer({ chunks: [Buffer.alloc(9)] }), /volumineuse/);
  await assert.rejects(transfer({ chunks: [Buffer.alloc(5)] }), /interrompue/);
});

for (const dialect of ['sqlite', 'postgres']) {
  test('cinéma: droits, publication, durée vérifiée et retrait sur ' + dialect, async t => {
    const directory = dialect === 'sqlite' ? await mkdtemp(join(tmpdir(), 'gasa-cinema-test-')) : null;
    const db = dialect === 'sqlite' ? await openDatabase({ connectionString: '', dataDir: directory }) : await localPostgres();
    t.after(async () => {
      await db.close();
      if (directory?.startsWith(join(tmpdir(), 'gasa-cinema-test-'))) await rm(directory, { recursive: true, force: true });
    });
    await db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL);");
    await db.prepare('INSERT INTO sessions (id, title, status) VALUES (?, ?, ?)').run('published', 'Projection campus', 'published');
    await db.prepare('INSERT INTO sessions (id, title, status) VALUES (?, ?, ?)').run('draft', 'Séance secrète', 'draft');
    await db.prepare('INSERT INTO sessions (id, title, status) VALUES (?, ?, ?)').run('archived', 'Projection archivée', 'archived');
    await db.exec('CREATE TABLE cinema_audit (session_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);');
    const app = express();
    app.use(express.json());
    const api = express.Router();
    app.use('/api', api);
    let probes = 0;
    let inMutation = false;
    let rejectJournal = false;
    let lastEvent;
    const cinema = await installCinema({ api, db, auth: {
      requireStudent: (req, res, next) => req.get('x-student') === 'yes' ? next() : res.status(401).json({ error: 'Connexion requise.' }),
      requireAdmin: capability => (req, res, next) => {
        if (req.get('x-admin') !== capability) return res.status(403).json({ error: 'Droit requis.' });
        req.admin = { username: 'comite', role: req.get('x-role') || 'organizer',
          capabilities: ['edit', ...(req.get('x-archive') === 'yes' ? ['archive'] : [])] };
        next();
      },
    }, probe: async () => {
      assert.equal(inMutation, false, 'le réseau MP4 est vérifié avant la transaction');
      probes += 1;
      return 1600;
    }, mutate: work => db.transaction(async () => {
      inMutation = true;
      try { return await work(); } finally { inMutation = false; }
    }), onChange: async event => {
      assert.equal(inMutation, true, 'le journal est écrit dans la transaction cinéma');
      await db.prepare('INSERT INTO cinema_audit (session_id,kind,detail) VALUES (?,?,?)')
        .run(event.session.id, event.kind, event.detail);
      if (rejectJournal) throw new Error('Journal indisponible');
      lastEvent = event;
    } });
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const input = { enabled: true, title: 'La fin du film', clipUrl: 'https://media.example.test/suite.mp4',
      fullUrl: 'https://cinema.example.test/film', durationSeconds: 4 };
    const request = async (path, { body, headers, method = 'GET' } = {}) => {
      const response = await fetch(origin + '/api' + path, {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, data: await response.json() };
    };
    assert.equal((await request('/admin/sessions/published/cinema', { method: 'POST', body: input })).response.status, 403);
    const saved = await request('/admin/sessions/published/cinema', { method: 'POST', body: { cinema: input }, headers: { 'x-admin': 'edit' } });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.cinema.durationSeconds, 1600, 'la durée indiquée par le client est ignorée');
    assert.equal(probes, 1);
    assert.equal(lastEvent.kind, 'admin.cinema-update');
    assert.deepEqual(lastEvent.session, { id: 'published', title: 'Projection campus' });
    assert.equal(lastEvent.admin.username, 'comite');
    assert.match(lastEvent.detail, /activé/);
    const beforeFailure = await cinema.readForSession('published');
    rejectJournal = true;
    assert.equal((await request('/admin/sessions/published/cinema', { method: 'POST',
      body: { ...input, title: 'Modification annulée' }, headers: { 'x-admin': 'edit' } })).response.status, 500);
    rejectJournal = false;
    assert.deepEqual(await cinema.readForSession('published'), beforeFailure, 'une erreur de journal annule la modification cinéma');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM cinema_audit').get()).count, 1,
      'le journal et le cinéma sont annulés ensemble');
    await cinema.saveForSession('draft', input);
    assert.equal((await request('/sessions/published/cinema')).response.status, 401);
    const catalog = await request('/cinema');
    assert.deepEqual(catalog.data.items, [{ sessionId: 'published', title: input.title, sessionTitle: 'Projection campus',
      durationSeconds: 1600, available: true, fullUrl: input.fullUrl }]);
    assert.equal(JSON.stringify(catalog.data).includes('suite.mp4'), false);
    const playing = await request('/sessions/published/cinema', { headers: { 'x-student': 'yes' } });
    assert.equal(playing.response.status, 200);
    assert.equal(playing.data.cinema.clipUrl, input.clipUrl);
    assert.match(playing.response.headers.get('cache-control'), /private, no-store/);
    assert.equal((await request('/sessions/draft/cinema', { headers: { 'x-student': 'yes' } })).response.status, 404);
    assert.equal((await request('/admin/sessions/archived/cinema', { method: 'POST', body: input,
      headers: { 'x-admin': 'edit' } })).response.status, 403, 'une archive reste réservée au responsable');
    assert.equal(await cinema.readForSession('archived'), null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM cinema_audit').get()).count, 1);
    assert.equal((await request('/admin/sessions/archived/cinema', { method: 'POST', body: input,
      headers: { 'x-admin': 'edit', 'x-role': 'owner' } })).response.status, 200);
    assert.equal((await request('/admin/sessions/archived/cinema', { method: 'POST', body: { cinema: null },
      headers: { 'x-admin': 'edit', 'x-archive': 'yes' } })).response.status, 200,
    'la capacité archive autorise également le retrait');
    assert.equal(lastEvent.detail, 'Extrait retiré');
    assert.equal((await request('/admin/sessions/absent/cinema', { method: 'POST', body: { cinema: null },
      headers: { 'x-admin': 'edit' } })).response.status, 404);
    const validated = await cinema.validateCinema({ ...input, enabled: false });
    const probesBeforePersist = probes;
    await db.transaction(() => cinema.persistCinema('published', validated));
    assert.equal(probes, probesBeforePersist, 'persistance sans accès réseau, utilisable dans la transaction');
    assert.deepEqual((await request('/cinema')).data.items, []);
    assert.equal((await request('/sessions/published/cinema', { headers: { 'x-student': 'yes' } })).response.status, 404);
    await cinema.saveForSession('published', null);
    assert.equal(await cinema.readForSession('published'), null);
    await assert.rejects(cinema.saveForSession('absent', input), error => error.status === 404);
    await assert.rejects(cinema.validateCinema({ ...input, fullUrl: 'javascript:alert(1)' }), error => error.status === 400);
  });
}
