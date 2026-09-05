/* ============================================================================
   FSN — PUSH NOTIFICATION SERVICE (client)
   ----------------------------------------------------------------------------
   The device half of the push stack. It owns exactly three things:

     1. Deciding which transport this runtime can use — APNs through the
        Capacitor plugin in the iOS binary, Web Push through a service worker
        on the Vercel-served web app.
     2. Capturing the push address AFTER the reader opts in, and registering it
        with /api/notifications-register along with their three preference
        switches and their timezone.
     3. Keeping the league context on that row fresh, so the dispatcher can key
        the send ledger to the live week and anchor the Thursday alert to the
        week's real opening kickoff.

   ---- THE PERMISSION RULE ----

   boot() NEVER triggers the system permission prompt. Not once, not on the
   first launch, not "just to check". A cold prompt on first launch is the
   single fastest way to a permanent denial, and on iOS a denial cannot be
   undone from inside the app — the reader has to find it in Settings, which
   they will not do. So the OS prompt is reached from exactly one place:
   enable(), which the Setup screen calls in direct response to a tap on a
   button that has already explained what the alerts are.

   What boot() DOES do is silently re-register a device that has ALREADY opted
   in and already granted permission, because APNs tokens rotate and a stale
   token is a silently undelivered notification. That path cannot prompt: it
   checks the existing permission state and returns early unless it is already
   'granted'.

   ---- WHY THIS FILE IS AT GLOBAL SCOPE ----

   index.html ships as several independent inline <script> blocks and CLAUDE.md
   rule 1 forbids a cross-block helper from living inside one of their IIFEs.
   The Setup screen (block 6) drives this service and the data engine (block 1)
   feeds it league context, so it loads at global scope before all of them and
   publishes a single API on window.FSNNotifications — the same arrangement
   editorialScheduleEngine.js already uses.

   Every catch here reports through console.error / console.warn tagged
   [FSNPush] with the operation that failed and the error object itself, per
   CLAUDE.md rule 3. The only silent catches are the localStorage probes, which
   is the "optional browser API that throws by design" case that rule carves
   out.
============================================================================ */
(function () {
  'use strict';

  var REGISTER_ENDPOINT = '/api/notifications-register';
  var SERVICE_WORKER_PATH = '/sw.js';

  /* Under the `fsn.` prefix so the Setup screen's "Erase stored data" control
     already sweeps these up without needing to learn about them. */
  var PREFS_KEY = 'fsn.notify.prefs.v1';
  var DEVICE_KEY = 'fsn.notify.device.v1';
  var OPTIN_KEY = 'fsn.notify.optin.v1';

  /* The three engagement windows. Must stay in step with PREF_GROUPS in
     api/notifications/triggers.js — the server drops any key it does not
     recognise, so a mismatch shows up as a switch that silently never fires. */
  var GROUPS = ['tuesday', 'thursday', 'sunday'];

  /* A Capacitor registration event has no timeout of its own; without one a
     failed APNs handshake leaves enable() pending forever and the Setup toggle
     spins with no explanation. */
  var TOKEN_TIMEOUT_MS = 15000;

  /* ==========================================================================
     STORAGE — same defensive posture as the app's FSNStore
  ========================================================================== */

  /* Prefer the app's own store when it has loaded (it handles quota eviction
     and reports failures); fall back to raw localStorage so this service still
     works if it is ever used before block 1 defines FSNStore. */
  function store() {
    try {
      if (window.FSNStore && typeof window.FSNStore.get === 'function') return window.FSNStore;
    } catch (err) { /* window access in a hostile embed */ }
    return null;
  }

  function readKey(key) {
    var s = store();
    if (s) {
      try { return s.get(key); } catch (err) {
        console.warn('[FSNPush] FSNStore read failed for ' + key, err);
      }
    }
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }

  function writeKey(key, value) {
    var s = store();
    if (s) {
      try { s.set(key, value); return; } catch (err) {
        console.warn('[FSNPush] FSNStore write failed for ' + key, err);
      }
    }
    try { window.localStorage.setItem(key, value); } catch (err) { /* private mode */ }
  }

  function dropKey(key) {
    var s = store();
    if (s && typeof s.remove === 'function') {
      try { s.remove(key); return; } catch (err) {
        console.warn('[FSNPush] FSNStore remove failed for ' + key, err);
      }
    }
    try { window.localStorage.removeItem(key); } catch (err) { /* private mode */ }
  }

  /* ==========================================================================
     STATE
  ========================================================================== */

  function defaultPrefs() {
    return { tuesday: true, thursday: true, sunday: true };
  }

  function normalizePrefs(value) {
    var source = (value && typeof value === 'object') ? value : {};
    var out = {};
    for (var i = 0; i < GROUPS.length; i++) {
      out[GROUPS[i]] = source[GROUPS[i]] === true;
    }
    return out;
  }

  function loadPrefs() {
    var raw = readKey(PREFS_KEY);
    if (!raw) return defaultPrefs();
    try {
      return normalizePrefs(JSON.parse(raw));
    } catch (err) {
      console.warn('[FSNPush] stored notification preferences were unreadable; ' +
        'falling back to the defaults.', err);
      return defaultPrefs();
    }
  }

  var state = {
    /* 'ios' | 'web' | null (this runtime cannot receive push at all) */
    platform: null,
    /* Has the deployment configured any transport? Answered by the GET on the
       register endpoint; null until asked. */
    configured: null,
    vapidPublicKey: '',
    /* 'granted' | 'denied' | 'prompt' | 'unsupported' */
    permission: 'prompt',
    /* The reader's own switch, independent of the OS permission. Someone can
       be permitted-but-opted-out, which is a normal state we must not confuse
       with never having been asked. */
    optedIn: readKey(OPTIN_KEY) === '1',
    deviceId: readKey(DEVICE_KEY) || '',
    prefs: loadPrefs(),
    busy: false,
    lastError: '',
  };

  /* League context, fed in by the app as it loads. Held separately from
     `state` because it is not reader-facing. */
  var context = {
    leagueId: '',
    teamId: '',
    seasonYear: null,
    week: null,
    firstKickoffMs: null,
  };

  var listeners = [];

  function snapshot() {
    return {
      supported: !!state.platform,
      platform: state.platform,
      configured: state.configured,
      permission: state.permission,
      optedIn: state.optedIn,
      registered: !!state.deviceId,
      deviceId: state.deviceId,
      prefs: normalizePrefs(state.prefs),
      busy: state.busy,
      lastError: state.lastError,
    };
  }

  function emit() {
    var snap = snapshot();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](snap);
      } catch (err) {
        console.error('[FSNPush] a notification state listener threw', err);
      }
    }
  }

  function setBusy(value) {
    state.busy = !!value;
    emit();
  }

  function fail(operation, err) {
    state.lastError = operation;
    console.error('[FSNPush] ' + operation, err);
    emit();
  }

  /* ==========================================================================
     PLATFORM DETECTION
  ========================================================================== */

  function capacitorPush() {
    try {
      var C = window.Capacitor;
      if (!C) return null;
      var native = typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : !!C.isNative;
      if (!native) return null;
      var plugins = C.Plugins || {};
      return plugins.PushNotifications || null;
    } catch (err) {
      console.warn('[FSNPush] Capacitor detection failed', err);
      return null;
    }
  }

  function webPushSupported() {
    try {
      return ('serviceWorker' in navigator) &&
             ('PushManager' in window) &&
             (typeof window.Notification === 'function');
    } catch (err) {
      return false;
    }
  }

  function detectPlatform() {
    if (capacitorPush()) return 'ios';
    if (webPushSupported()) return 'web';
    return null;
  }

  function timezone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) return tz;
    } catch (err) {
      console.warn('[FSNPush] could not resolve this device timezone from Intl', err);
    }
    /* The server rejects a registration with no usable zone rather than
       defaulting to UTC, so returning '' here surfaces a real error instead of
       quietly scheduling every alert on the wrong clock. */
    return '';
  }

  /* ==========================================================================
     TRANSPORT: iOS / Capacitor
  ========================================================================== */

  function iosPermission() {
    var PN = capacitorPush();
    if (!PN) return Promise.resolve('unsupported');
    return PN.checkPermissions()
      .then(function (result) { return String((result && result.receive) || 'prompt'); })
      .catch(function (err) {
        fail('could not read the iOS notification permission state', err);
        return 'prompt';
      });
  }

  /* Resolves the APNs device token.

     PushNotifications.register() resolves as soon as the request is handed to
     the OS — the token itself arrives later on the 'registration' event — so
     this bridges the two into one promise, with a timeout because a failed
     APNs handshake otherwise never settles either way. */
  function iosToken() {
    var PN = capacitorPush();
    if (!PN) return Promise.reject(new Error('CAPACITOR_PUSH_UNAVAILABLE'));

    return new Promise(function (resolve, reject) {
      var settled = false;
      var handles = [];

      function cleanup() {
        for (var i = 0; i < handles.length; i++) {
          try {
            if (handles[i] && typeof handles[i].remove === 'function') handles[i].remove();
          } catch (err) {
            console.warn('[FSNPush] could not detach a Capacitor push listener', err);
          }
        }
        handles.length = 0;
      }

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('APNS_REGISTRATION_TIMEOUT'));
      }, TOKEN_TIMEOUT_MS);

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        fn(value);
      }

      /* addListener returns a promise for the handle in Capacitor 6. */
      Promise.resolve(PN.addListener('registration', function (token) {
        finish(resolve, String((token && token.value) || ''));
      })).then(function (h) { handles.push(h); })
        .catch(function (err) { fail('could not attach the APNs registration listener', err); });

      Promise.resolve(PN.addListener('registrationError', function (error) {
        finish(reject, new Error('APNS_REGISTRATION_FAILED: ' +
          String((error && (error.error || error.message)) || 'unknown')));
      })).then(function (h) { handles.push(h); })
        .catch(function (err) { fail('could not attach the APNs error listener', err); });

      PN.register().catch(function (err) { finish(reject, err); });
    });
  }

  /* ==========================================================================
     TRANSPORT: Web Push
  ========================================================================== */

  function webPermission() {
    try {
      return String(window.Notification.permission || 'default') === 'default'
        ? 'prompt'
        : String(window.Notification.permission);
    } catch (err) {
      return 'unsupported';
    }
  }

  /* VAPID keys travel as base64url; PushManager wants raw bytes. */
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  function webSubscription(vapidPublicKey) {
    if (!vapidPublicKey) {
      return Promise.reject(new Error('VAPID_PUBLIC_KEY_MISSING'));
    }
    return navigator.serviceWorker.register(SERVICE_WORKER_PATH)
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function (registration) {
        return registration.pushManager.getSubscription().then(function (existing) {
          /* Reuse an existing subscription rather than minting a second one
             for the same browser — two live subscriptions means every alert
             arrives twice. */
          if (existing) return existing;
          return registration.pushManager.subscribe({
            /* Required by Chrome and Firefox: every push must result in a
               visible notification. These all do. */
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
          });
        });
      })
      .then(function (subscription) { return subscription.toJSON(); });
  }

  /* ==========================================================================
     SERVER
  ========================================================================== */

  function loadServerConfig() {
    return fetch(REGISTER_ENDPOINT, { method: 'GET', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP_' + response.status);
        return response.json();
      })
      .then(function (config) {
        state.configured = !!(config && config.configured);
        state.vapidPublicKey = String((config && config.vapidPublicKey) || '');
        return config;
      })
      .catch(function (err) {
        /* A warn, not an error: the most common cause is simply that push has
           not been provisioned for this deployment yet, which is a legitimate
           state the Setup screen renders honestly rather than a fault. */
        console.warn('[FSNPush] could not read the push configuration from ' +
          REGISTER_ENDPOINT + '; the Setup screen will show push as unavailable.', err);
        state.configured = false;
        return null;
      });
  }

  function postRegistration(payload) {
    return fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          throw new Error('REGISTER_' + response.status + ':' + String(data && data.error || ''));
        }
        return data;
      });
    });
  }

  /* Capture the address for whichever transport this runtime uses, then send it
     with the reader's preferences and league context. */
  function registerDevice() {
    var platform = state.platform;
    if (!platform) return Promise.reject(new Error('PUSH_UNSUPPORTED'));

    var tz = timezone();
    if (!tz) return Promise.reject(new Error('TIMEZONE_UNAVAILABLE'));

    var addressPromise = platform === 'ios'
      ? iosToken().then(function (token) { return { token: token }; })
      : webSubscription(state.vapidPublicKey).then(function (sub) { return { subscription: sub }; });

    return addressPromise.then(function (address) {
      var payload = {
        platform: platform,
        timezone: tz,
        prefs: normalizePrefs(state.prefs),
        leagueId: context.leagueId || null,
        teamId: context.teamId || null,
        seasonYear: context.seasonYear,
        week: context.week,
        firstKickoffMs: context.firstKickoffMs,
      };
      if (address.token) payload.token = address.token;
      if (address.subscription) payload.subscription = address.subscription;
      return postRegistration(payload);
    }).then(function (result) {
      state.deviceId = String((result && result.deviceId) || '');
      writeKey(DEVICE_KEY, state.deviceId);
      return result;
    });
  }

  /* ==========================================================================
     PUBLIC API
  ========================================================================== */

  /* --------------------------------------------------------------------------
     boot()

     Safe to call unconditionally on app start. It reads the permission state
     but never asks for it. The one side effect is a silent re-registration for
     a device that is ALREADY opted in and already permitted, which keeps a
     rotated APNs token from becoming a silently dead subscription.
  -------------------------------------------------------------------------- */
  function boot() {
    state.platform = detectPlatform();
    if (!state.platform) {
      state.permission = 'unsupported';
      emit();
      return Promise.resolve(snapshot());
    }

    var permissionPromise = state.platform === 'ios'
      ? iosPermission()
      : Promise.resolve(webPermission());

    return permissionPromise.then(function (permission) {
      state.permission = permission;
      emit();
      return loadServerConfig();
    }).then(function () {
      /* The gate that keeps boot silent. Anything other than an already-opted-in,
         already-granted device stops here — no prompt, no registration. */
      if (!state.optedIn || state.permission !== 'granted' || !state.configured) {
        emit();
        return snapshot();
      }
      return registerDevice().then(function () {
        emit();
        return snapshot();
      }).catch(function (err) {
        fail('silent re-registration failed on boot; this device may stop ' +
          'receiving alerts until the reader reopens Setup', err);
        return snapshot();
      });
    }).catch(function (err) {
      fail('notification boot failed', err);
      return snapshot();
    });
  }

  /* --------------------------------------------------------------------------
     enable(prefs)

     THE ONLY PATH THAT MAY PROMPT. Call it from a real user gesture — both
     iOS and every browser require one, and Safari silently refuses otherwise.
  -------------------------------------------------------------------------- */
  function enable(prefs) {
    if (prefs) state.prefs = normalizePrefs(prefs);

    if (!state.platform) state.platform = detectPlatform();
    if (!state.platform) {
      var unsupported = new Error('PUSH_UNSUPPORTED');
      fail('this device cannot receive push notifications', unsupported);
      return Promise.reject(unsupported);
    }

    setBusy(true);
    state.lastError = '';

    var configReady = state.configured === null
      ? loadServerConfig()
      : Promise.resolve(null);

    return configReady.then(function () {
      if (!state.configured) throw new Error('PUSH_NOT_CONFIGURED');

      if (state.platform === 'ios') {
        var PN = capacitorPush();
        return PN.requestPermissions().then(function (result) {
          return String((result && result.receive) || 'denied');
        });
      }
      return window.Notification.requestPermission().then(function (result) {
        return String(result) === 'default' ? 'prompt' : String(result);
      });
    }).then(function (permission) {
      state.permission = permission;
      if (permission !== 'granted') {
        /* Not an error condition — a reader is allowed to say no. Record it and
           leave the switch off so the UI can explain how to change their mind. */
        state.optedIn = false;
        writeKey(OPTIN_KEY, '0');
        setBusy(false);
        return snapshot();
      }
      return registerDevice().then(function () {
        state.optedIn = true;
        writeKey(OPTIN_KEY, '1');
        writeKey(PREFS_KEY, JSON.stringify(normalizePrefs(state.prefs)));
        setBusy(false);
        return snapshot();
      });
    }).catch(function (err) {
      state.optedIn = false;
      writeKey(OPTIN_KEY, '0');
      setBusy(false);
      fail('could not turn on push notifications', err);
      throw err;
    });
  }

  /* --------------------------------------------------------------------------
     disable()

     Removes the server row. The OS permission is deliberately left alone —
     only the reader can revoke that, and re-enabling later should not have to
     re-prompt.
  -------------------------------------------------------------------------- */
  function disable() {
    var deviceId = state.deviceId;
    state.optedIn = false;
    writeKey(OPTIN_KEY, '0');
    setBusy(true);

    var done = function () {
      state.deviceId = '';
      dropKey(DEVICE_KEY);
      setBusy(false);
      return snapshot();
    };

    if (!deviceId) return Promise.resolve(done());

    return postRegistration({ unsubscribe: true, deviceId: deviceId })
      .then(done)
      .catch(function (err) {
        /* The local switch is already off, so the reader sees what they asked
           for; the row may linger until the next successful call. Say so
           rather than pretending the unsubscribe landed. */
        fail('the device was switched off locally but the server row could not ' +
          'be removed; it will be retried on the next change', err);
        return done();
      });
  }

  /* --------------------------------------------------------------------------
     setPrefs(prefs)

     Update the three switches. With the master switch on this re-registers so
     the server row matches immediately; with it off it only persists locally,
     so a reader can pre-set what they want before opting in.
  -------------------------------------------------------------------------- */
  function setPrefs(prefs) {
    state.prefs = normalizePrefs(prefs);
    writeKey(PREFS_KEY, JSON.stringify(state.prefs));

    /* All three off is the same intent as the master switch off. Retire the row
       rather than leaving a device registered to receive nothing. */
    var anyOn = GROUPS.some(function (g) { return state.prefs[g] === true; });
    if (state.optedIn && !anyOn) return disable();

    if (!state.optedIn || state.permission !== 'granted') {
      emit();
      return Promise.resolve(snapshot());
    }

    setBusy(true);
    return registerDevice().then(function () {
      setBusy(false);
      return snapshot();
    }).catch(function (err) {
      setBusy(false);
      fail('could not save the notification preferences to the server', err);
      return snapshot();
    });
  }

  /* --------------------------------------------------------------------------
     setLeagueContext(ctx)

     Fed by the app whenever the league, the week, or the schedule changes.
     Re-registers only when something the dispatcher actually uses has moved,
     so a repaint loop cannot turn into a write loop.
  -------------------------------------------------------------------------- */
  function setLeagueContext(ctx) {
    var next = ctx || {};
    var changed = false;

    function assign(key, value) {
      if (context[key] === value) return;
      context[key] = value;
      changed = true;
    }

    assign('leagueId', String(next.leagueId == null ? '' : next.leagueId));
    assign('teamId', String(next.teamId == null ? '' : next.teamId));
    assign('seasonYear', Number.isFinite(Number(next.seasonYear)) ? Number(next.seasonYear) : null);
    assign('week', Number.isFinite(Number(next.week)) ? Number(next.week) : null);
    assign('firstKickoffMs', Number.isFinite(Number(next.firstKickoffMs)) ? Number(next.firstKickoffMs) : null);

    if (!changed || !state.optedIn || state.permission !== 'granted' || !state.configured) {
      return Promise.resolve(snapshot());
    }

    return registerDevice().then(function () {
      return snapshot();
    }).catch(function (err) {
      fail('could not refresh the league context on this device registration', err);
      return snapshot();
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return function () {};
    listeners.push(listener);
    try {
      listener(snapshot());
    } catch (err) {
      console.error('[FSNPush] a notification state listener threw on attach', err);
    }
    return function () {
      var i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  var api = {
    boot: boot,
    enable: enable,
    disable: disable,
    setPrefs: setPrefs,
    setLeagueContext: setLeagueContext,
    subscribe: subscribe,
    state: snapshot,
    groups: GROUPS.slice(),
  };

  try {
    window.FSNNotifications = api;
  } catch (err) {
    console.error('[FSNPush] global publish failed; the Setup screen will not find ' +
      'the notification service.', err);
  }
})();
