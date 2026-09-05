/* ============================================================================
   FSN — SERVICE WORKER

   Web Push delivery ONLY. This worker exists because a browser will not accept
   a push subscription without one; it is not a caching or offline layer.

   ---- WHAT THIS WORKER DELIBERATELY DOES NOT DO ----

   No fetch handler. No precache. No cache-first anything.

   index.html is a single 1.3MB static file that Vercel serves from the repo
   root with no build step and no content hash in its URL. A service worker
   that cached it would pin readers to whichever build they happened to install
   first, and every subsequent deploy would look green in Vercel while the
   readers who mattered kept seeing the old app. There is no cache-busting
   scheme here to make that safe, so the worker never touches navigation
   requests at all — it registers, it receives pushes, and it opens the app.
============================================================================ */

/* eslint-env serviceworker */

/* Take over immediately so a reader who just opted in does not have to reload
   before the first push can be delivered. */
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

/* --------------------------------------------------------------------------
   push

   The payload is written by api/notifications/triggers.js:
     { title, body, category, data: { trigger, group, leagueId, season, week, url } }

   Chrome and Firefox require every push to produce a visible notification
   (the subscription was made with userVisibleOnly), so the catch path still
   shows something rather than letting the browser post its own generic
   "This site has been updated in the background" notice.
-------------------------------------------------------------------------- */
self.addEventListener('push', function (event) {
  var payload = null;

  if (event.data) {
    try {
      payload = event.data.json();
    } catch (err) {
      console.error('[FSNPush][sw] push payload was not JSON; showing a generic alert', err);
    }
  }

  var title = (payload && payload.title) || 'Fantasy Sports Network';
  var options = {
    body: (payload && payload.body) || 'Your league desk has an update.',
    /* No `icon` / `badge`. assets/ holds only the 1024px iOS masters that
       @capacitor/assets consumes — there is no web-sized PNG served from this
       origin, and pointing at one that 404s renders worse than the browser's
       own default. Add them here once a real web icon ships. */
    /* Collapse repeats of the same cadence: a reader who missed Tuesday should
       not find two waiver notifications stacked up. */
    tag: 'fsn-' + String((payload && payload.data && payload.data.group) || 'general'),
    renotify: true,
    data: (payload && payload.data) || {},
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch(function (err) {
      console.error('[FSNPush][sw] showNotification failed for "' + title + '"', err);
    })
  );
});

/* --------------------------------------------------------------------------
   notificationclick

   Focus an already-open FSN tab rather than opening a second one; only fall
   back to openWindow when none is running.
-------------------------------------------------------------------------- */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ('focus' in client) {
            /* navigate() is not implemented everywhere; focusing the existing
               tab is the part that matters, so a navigate failure must not
               swallow the focus. */
            if (typeof client.navigate === 'function') {
              return client.navigate(target)
                .then(function (navigated) { return (navigated || client).focus(); })
                .catch(function (err) {
                  console.warn('[FSNPush][sw] could not navigate the existing tab to ' +
                    target + '; focusing it as-is', err);
                  return client.focus();
                });
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
      .catch(function (err) {
        console.error('[FSNPush][sw] could not surface the app for ' + target, err);
      })
  );
});
