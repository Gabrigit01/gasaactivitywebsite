const fallbackTitle = 'Vie étudiante GASA';
const fallbackBody = 'Une nouvelle information est disponible.';

function targetUrl(value) {
  const origin = self.location.origin;
  try {
    const url = new URL(value, origin);
    if (url.origin === origin && url.pathname === '/') return url.href;
  } catch {
    // Une notification incomplète renvoie simplement à l’accueil.
  }
  return new URL('/', origin).href;
}

function readNotice(data) {
  try {
    return data?.json() || {};
  } catch {
    return {};
  }
}

function stringOr(value, fallback, length) {
  return typeof value === 'string' && value.trim() ? value.slice(0, length) : fallback;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const notice = readNotice(event.data);
  const title = stringOr(notice.title, fallbackTitle, 90);
  const options = {
    body: stringOr(notice.body, fallbackBody, 160),
    icon: '/images/app-icon-192.png',
    tag: stringOr(notice.tag, 'gasa-info', 80),
    data: { url: targetUrl(notice.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const url = targetUrl(event.notification.data?.url);
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url === url);
    if (existing) await existing.focus();
    else if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  if (!event.newSubscription) return;
  event.waitUntil((async () => {
    const replacement = event.newSubscription.toJSON();
    const options = { headers: { 'Content-Type': 'application/json' } };
    try {
      const response = await fetch('/api/push/subscriptions', {
        ...options, method: 'POST', body: JSON.stringify(replacement),
      });
      const old = event.oldSubscription?.toJSON();
      if (response.ok && old && old.endpoint !== replacement.endpoint) {
        await fetch('/api/push/subscriptions', { ...options, method: 'DELETE', body: JSON.stringify(old) });
      }
    } catch {
      // Le prochain passage sur le site pourra resynchroniser l’abonnement.
    }
  })());
});
