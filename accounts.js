import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const day = 24 * 60 * 60 * 1000;
const studentDuration = 365 * day;
const adminDuration = 180 * day;
const attemptWindow = 15 * 60 * 1000;
const maxParallelDerivations = 3;
const maxQueuedDerivations = 24;

const roleCapabilities = {
  owner: ['read', 'edit', 'archive', 'moderate', 'share', 'export'],
  organizer: ['read', 'edit', 'moderate', 'share'],
  viewer: ['read'],
};

export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireAccount(condition, status, message) {
  if (!condition) throw new AccountError(status, message);
}

function digest(...values) {
  const hash = createHash('sha256');
  for (const value of values) hash.update(value);
  return hash.digest();
}

function cleanUsername(input) {
  if (typeof input !== 'string') return '';
  const username = input.trim().toLowerCase();
  return /^[a-z0-9._@-]{3,64}$/.test(username) ? username : '';
}

function cleanEmail(input) {
  if (typeof input !== 'string') return '';
  const email = input.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : '';
}

function isPassword(input) {
  return typeof input === 'string' && input.length >= 1 && input.length <= 128;
}

function readCookie(req, name) {
  const cookie = req.get('cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(cookie) ? cookie : null;
}

function publicStudent(row) {
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

function publicAdmin(admin) {
  return admin ? { username: admin.username, role: admin.role, capabilities: roleCapabilities[admin.role] } : null;
}

function readAdminConfig(production) {
  const accounts = Object.keys(roleCapabilities).flatMap((role) => {
    const prefix = 'ADMIN_' + role.toUpperCase();
    const rawUsername = process.env[prefix + '_USERNAME'];
    const password = process.env[prefix + '_PASSWORD'];
    if (!rawUsername && !password) return [];
    const username = cleanUsername(rawUsername);
    if (!username || !isPassword(password) || password.length < 12) {
      throw new Error(prefix + ' doit définir un identifiant valide et un mot de passe de 12 à 128 caractères.');
    }
    return [{ username, password, role }];
  });
  if (production && accounts.length !== 3) {
    throw new Error('Configurez les trois comptes ADMIN_OWNER, ADMIN_ORGANIZER et ADMIN_VIEWER pour la production.');
  }
  if (new Set(accounts.map(({ username }) => username)).size !== accounts.length
    || new Set(accounts.map(({ password }) => password)).size !== accounts.length) {
    throw new Error('Attribuez un identifiant et un mot de passe distincts à chaque compte du comité.');
  }

  const legacyPassword = process.env.ADMIN_PASSWORD;
  if (!production && !accounts.length && legacyPassword) {
    if (!isPassword(legacyPassword)) throw new Error('ADMIN_PASSWORD doit faire au plus 128 caractères.');
    return { accounts: [{ username: 'comite', password: legacyPassword, role: 'owner' }], legacy: true };
  }
  return { accounts, legacy: false };
}

export async function installAccounts({ api, db, production, onStudentAuthenticated }) {
  const { accounts, legacy } = readAdminConfig(production);
  const signupCode = process.env.STUDENT_SIGNUP_CODE?.trim() || '';
  const signupCodeHash = signupCode ? digest(signupCode) : null;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS student_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      salt BLOB NOT NULL,
      password_hash BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_auth_sessions (
      token_hash TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES student_accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS student_auth_expires ON student_auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS committee_auth_sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      credential_tag TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS committee_auth_expires ON committee_auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_settings (
      name TEXT PRIMARY KEY,
      value BLOB NOT NULL
    );
  `);

  await db.prepare("INSERT INTO auth_settings (name, value) VALUES ('committee_salt', ?) ON CONFLICT (name) DO NOTHING")
    .run(randomBytes(32));
  const committeeSalt = (await db.prepare("SELECT value FROM auth_settings WHERE name = 'committee_salt'").get()).value;
  const adminUsers = new Map();
  for (const config of accounts) {
    const { username, role, password } = config;
    const salt = digest(committeeSalt, username);
    const hash = await derive(password, salt, 32, scryptOptions);
    const tag = digest(role, '\0', hash).toString('hex');
    adminUsers.set(username, { username, role, salt, hash, tag });
  }
  const dummySalt = randomBytes(16);
  const dummyHash = randomBytes(32);
  let activeDerivations = 0;
  const queuedDerivations = [];

  async function derivePassword(password, salt) {
    if (activeDerivations < maxParallelDerivations) {
      activeDerivations++;
    } else {
      requireAccount(queuedDerivations.length < maxQueuedDerivations, 429,
        'Trop de tentatives simultanées. Réessayez dans un instant.');
      await new Promise((resolve) => queuedDerivations.push(resolve));
    }
    try {
      return await derive(password, salt, 32, scryptOptions);
    } finally {
      const next = queuedDerivations.shift();
      if (next) next();
      else activeDerivations--;
    }
  }

  async function passwordMatches(password, salt, hash) {
    const valid = isPassword(password);
    const candidate = await derivePassword(valid ? password : '', salt ?? dummySalt);
    return valid && timingSafeEqual(candidate, hash ? Buffer.from(hash) : dummyHash);
  }

  const studentByEmail = db.prepare('SELECT * FROM student_accounts WHERE email = ?');
  const insertStudent = db.prepare(`
    INSERT INTO student_accounts (id, email, name, salt, password_hash)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING
  `);

  const cookies = {
    student: production ? '__Host-gasa_student' : 'gasa_student',
    admin: production ? '__Host-gasa_admin' : 'gasa_admin',
  };
  const studentCache = Symbol('student account');
  const adminCache = Symbol('committee account');

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'lax', secure: production || req.secure, path: '/' };
  }

  function sessionStatements(table) {
    return {
      remove: db.prepare('DELETE FROM ' + table + ' WHERE token_hash = ?'),
      expire: db.prepare('DELETE FROM ' + table + ' WHERE expires_at <= ?'),
      renew: db.prepare('UPDATE ' + table + ' SET expires_at = ? WHERE token_hash = ?'),
    };
  }
  const studentSessions = {
    ...sessionStatements('student_auth_sessions'),
    create: db.prepare('INSERT INTO student_auth_sessions (token_hash, student_id, expires_at) VALUES (?, ?, ?)'),
    find: db.prepare(`
      SELECT student_accounts.id, student_accounts.email, student_accounts.name, session.expires_at
      FROM student_auth_sessions AS session JOIN student_accounts ON student_accounts.id = session.student_id
      WHERE session.token_hash = ? AND session.expires_at > ?
    `),
  };
  const adminSessions = {
    ...sessionStatements('committee_auth_sessions'),
    create: db.prepare('INSERT INTO committee_auth_sessions (token_hash, username, credential_tag, expires_at) VALUES (?, ?, ?, ?)'),
    find: db.prepare('SELECT username, credential_tag, expires_at FROM committee_auth_sessions WHERE token_hash = ? AND expires_at > ?'),
  };

  function storedToken(token) {
    return digest(token).toString('hex');
  }

  function setSessionCookie(req, res, type, token, duration) {
    res.cookie(cookies[type], token, { ...cookieOptions(req), maxAge: duration });
  }

  async function renewIfNeeded(req, res, type, statements, token, expiresAt, duration, now) {
    if (expiresAt > now + duration - day) return;
    await statements.renew.run(now + duration, storedToken(token));
    setSessionCookie(req, res, type, token, duration);
  }

  async function findUserSession(req, res, type, statements, duration, verify) {
    const token = readCookie(req, cookies[type]);
    if (!token) return null;
    const now = Date.now();
    const hashed = storedToken(token);
    const row = await statements.find.get(hashed, now);
    const user = row ? verify(row) : null;
    if (!user) {
      await statements.remove.run(hashed);
      res.clearCookie(cookies[type], cookieOptions(req));
      return null;
    }
    await renewIfNeeded(req, res, type, statements, token, row.expires_at, duration, now);
    return user;
  }

  async function student(req, res) {
    req[studentCache] ??= findUserSession(req, res, 'student', studentSessions, studentDuration, publicStudent);
    return await req[studentCache];
  }

  async function admin(req, res) {
    req[adminCache] ??= findUserSession(req, res, 'admin', adminSessions, adminDuration, (row) => {
      const candidate = adminUsers.get(row.username);
      return candidate?.tag === row.credential_tag ? candidate : null;
    });
    return await req[adminCache];
  }

  async function beginSession(req, res, type, statements, duration, ...identity) {
    const previous = readCookie(req, cookies[type]);
    const token = randomBytes(32).toString('hex');
    await db.transaction(async () => {
      await statements.create.run(storedToken(token), ...identity, Date.now() + duration);
      if (previous) await statements.remove.run(storedToken(previous));
    });
    setSessionCookie(req, res, type, token, duration);
  }

  async function endSession(req, res, type, statements) {
    const token = readCookie(req, cookies[type]);
    if (token) await statements.remove.run(storedToken(token));
    res.clearCookie(cookies[type], cookieOptions(req));
  }

  const attempts = new Map();

  function limit(req, res, action, max, identity = req.ip || req.socket.remoteAddress || 'local') {
    const key = action + ':' + identity;
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (attempts.size >= 10000 && !attempts.has(key)) {
        throw new AccountError(429, 'Trop de tentatives. Veuillez réessayer dans quelques minutes.');
      }
      entry = { used: 0, expiresAt: now + attemptWindow };
      attempts.set(key, entry);
    }
    if (entry.used >= max) {
      res.set('Retry-After', String(Math.ceil((entry.expiresAt - now) / 1000)));
      throw new AccountError(429, 'Trop de tentatives. Veuillez réessayer dans quelques minutes.');
    }
    entry.used++;
  }

  let cleaning = false;
  async function cleanup() {
    if (cleaning) return;
    cleaning = true;
    try {
      const now = Date.now();
      await studentSessions.expire.run(now);
      await adminSessions.expire.run(now);
      for (const [key, { expiresAt }] of attempts) if (expiresAt <= now) attempts.delete(key);
    } finally {
      cleaning = false;
    }
  }
  await cleanup();
  const cleanupTimer = setInterval(() => {
    cleanup().catch(() => console.error('Le nettoyage des sessions n’a pas pu aboutir.'));
  }, 60_000);
  cleanupTimer.unref();

  function studentPayload(account) {
    return { authenticated: Boolean(account), student: account, signupCodeRequired: Boolean(signupCodeHash) };
  }

  function adminPayload(account) {
    return { authenticated: Boolean(account), configured: adminUsers.size > 0, legacy, admin: publicAdmin(account) };
  }

  async function signInStudent(req, res, account) {
    await onStudentAuthenticated?.(req, res, account);
    await beginSession(req, res, 'student', studentSessions, studentDuration, account.id);
  }

  api.get('/student/session', async (req, res) => res.json(studentPayload(await student(req, res))));

  api.post('/student/register', async (req, res) => {
    limit(req, res, 'register-address', 120);
    const { email: inputEmail, name: inputName, password, accessCode } = req.body ?? {};
    const email = cleanEmail(inputEmail);
    const name = typeof inputName === 'string' ? inputName.trim() : '';
    requireAccount(email, 400, 'Saisissez une adresse e-mail valide.');
    limit(req, res, 'register-email', 6, email);
    requireAccount(name.length >= 2 && name.length <= 100, 400, 'Saisissez un nom de 2 à 100 caractères.');
    requireAccount(isPassword(password) && password.length >= 12,
      400, 'Choisissez un mot de passe de 12 à 128 caractères.');
    requireAccount(!signupCodeHash || (typeof accessCode === 'string' && accessCode.length <= 256
      && timingSafeEqual(digest(accessCode.trim()), signupCodeHash)), 403, 'Le code d’inscription est incorrect.');

    const salt = randomBytes(16);
    const hash = await derivePassword(password, salt);
    const id = randomUUID();
    const result = await insertStudent.run(id, email, name, salt, hash);
    requireAccount(result.changes > 0, 409, 'Un compte utilise déjà cette adresse. Connectez-vous avec votre mot de passe.');
    const account = { id, email, name };
    await signInStudent(req, res, account);
    res.status(201).json(studentPayload(account));
  });

  api.post('/student/login', async (req, res) => {
    limit(req, res, 'student-login-address', 200);
    const email = cleanEmail(req.body?.email);
    if (email) limit(req, res, 'student-login-email', 15, email);
    const row = await studentByEmail.get(email);
    const matched = await passwordMatches(req.body?.password, row?.salt, row?.password_hash);
    requireAccount(row && matched, 401, 'Adresse e-mail ou mot de passe incorrect.');
    const account = publicStudent(row);
    await signInStudent(req, res, account);
    res.json(studentPayload(account));
  });

  api.post('/student/logout', async (req, res) => {
    await endSession(req, res, 'student', studentSessions);
    res.json(studentPayload(null));
  });

  api.get('/admin/session', async (req, res) => res.json(adminPayload(await admin(req, res))));

  api.post('/admin/login', async (req, res) => {
    requireAccount(adminUsers.size, 503, 'Configurez les comptes du comité avant de vous connecter.');
    limit(req, res, 'committee-login-address', 45);
    const username = legacy && !req.body?.username ? 'comite' : cleanUsername(req.body?.username);
    if (username) limit(req, res, 'committee-login-name', 10, username);
    const account = adminUsers.get(username);
    const matched = await passwordMatches(req.body?.password, account?.salt, account?.hash);
    requireAccount(account && matched, 401, 'Identifiant ou mot de passe incorrect.');
    await beginSession(req, res, 'admin', adminSessions, adminDuration, account.username, account.tag);
    res.json(adminPayload(account));
  });

  api.post('/admin/logout', async (req, res) => {
    await endSession(req, res, 'admin', adminSessions);
    res.json(adminPayload(null));
  });

  async function requireStudent(req, res, next) {
    req.student = await student(req, res);
    requireAccount(req.student, 401, 'Connectez-vous pour participer.');
    next();
  }

  function requireAdmin(capability = 'read') {
    return async (req, res, next) => {
      const account = await admin(req, res);
      requireAccount(account, 401, 'Connectez-vous pour ouvrir le tableau de bord.');
      requireAccount(roleCapabilities[account.role].includes(capability), 403, 'Vous n’avez pas accès à cette action.');
      req.admin = publicAdmin(account);
      next();
    };
  }

  return { student, admin, requireStudent, requireAdmin, close: () => clearInterval(cleanupTimer) };
}
