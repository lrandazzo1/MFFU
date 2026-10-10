/* ───────────────────────────────────────────────────────────────────────────
   The Focus Stack Diagnostic — vanilla build for the static site.

   Mirrors components/FocusStackDiagnostic.jsx (the Next.js version): same
   questions, same math, same archetypes, same copy, same behaviour — light
   theme, multi-select on the window and failure questions, affiliate slots in
   one table, and an inline reveal that never navigates. If you edit one, edit
   the other. All of the content lives in the maps at the top; the rendering
   below never needs touching to change wording.
─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── The math ────────────────────────────────────────────────────────────
     hours/day x 365 x YEARS_REMAINING / HOURS_PER_YEAR = years of life.
     Both are assumptions, not findings, and the result says so on screen. */
  var HOURS_PER_YEAR = 8760;
  var YEARS_REMAINING = 50;
  function yearsLost(h) { return (h * 365 * YEARS_REMAINING) / HOURS_PER_YEAR; }

  /* [PLACEHOLDER: point this at your list provider. Leave null for demo mode
     (the reveal still opens, nothing is sent).] */
  var ENDPOINT = null;

  /* ── Affiliate slots ─────────────────────────────────────────────────────
     Every recommended object is an entry here, so the links live in one place
     and nothing in the copy hard-codes a URL. affiliate:true marks the row and
     switches on the disclosure under the stack. Keep the copy objective: say
     what the thing does and when it is the wrong choice. */
  var TOOLS = {
    alarmClock: {
      name: 'A standalone alarm clock',
      href: '#', /* [PLACEHOLDER: affiliate link] */
      affiliate: true,
      note: 'Any dumb clock works. The point is that the phone loses its last excuse to sleep beside you.'
    },
    lockbox: {
      name: 'A timed lockbox',
      href: '#', /* [PLACEHOLDER: affiliate link] */
      affiliate: true,
      note: 'Useful for a fixed window you choose in advance. Useless if you are the kind of person who moves the box.'
    },
    deskTimer: {
      name: 'A physical timer',
      href: '#', /* [PLACEHOLDER: affiliate link] */
      affiliate: true,
      note: 'A visible countdown beats an app timer because it does not live on the device you are avoiding.'
    },
    eInkReader: {
      name: 'An e-ink reader',
      href: '#', /* [PLACEHOLDER: affiliate link] */
      affiliate: true,
      note: 'Only worth it if the thing you reach for is reading. It replaces a habit; it does not remove one.'
    },
    appBlocker: {
      name: 'A scheduled app blocker',
      href: '#', /* [PLACEHOLDER: affiliate link — Opal, Freedom, One Sec] */
      affiliate: true,
      note: 'Set it once on a schedule. Blockers you can snooze on impulse stop working within two weeks.'
    },
    screenTime: {
      name: 'Screen Time / Digital Wellbeing',
      href: 'https://support.apple.com/en-us/HT208982',
      affiliate: false,
      note: 'Free, already on your phone, and enough for most people. Start here before you pay for anything.'
    },
    greyscale: {
      name: 'Greyscale on an accessibility shortcut',
      href: 'https://support.apple.com/en-us/HT210984',
      affiliate: false,
      note: 'Triple-click to drain the colour. Costs nothing and takes about four minutes to set up.'
    }
  };

  var USAGE_BANDS = [
    { id: 'light',   label: '~2 hours',   hours: 2,   note: 'Well under average' },
    { id: 'typical', label: '3–4 hours',  hours: 3.5, note: 'The global average' },
    { id: 'heavy',   label: '5–6 hours',  hours: 5.5, note: 'Above average' },
    { id: 'severe',  label: '7+ hours',   hours: 7.5, note: 'Top decile' }
  ];

  /* multi:true renders square checkboxes and stores an array. */
  var QUESTIONS = [
    {
      key: 'windows', multi: true,
      title: 'When do you do your worst scrolling?',
      caption: 'Select every window that costs you.',
      options: [
        { id: 'morning',   label: 'Morning',    note: 'In bed, right after waking up' },
        { id: 'deepwork',  label: 'Deep work',  note: 'Mid-day slumps and task gaps' },
        { id: 'latenight', label: 'Late night', note: 'Bedtime doomscrolling' },
        { id: 'allday',    label: 'All day',    note: 'Unstructured, no clear pattern' }
      ]
    },
    {
      key: 'failed', multi: true,
      title: 'What have you already tried that failed?',
      caption: 'Select all of them — this is how we decide what to skip.',
      options: [
        { id: 'blockers',  label: 'App blockers',      note: 'Opal, Freedom, Screen Time limits' },
        { id: 'distance',  label: 'Physical distance', note: 'Another room, a lockbox, a drawer' },
        { id: 'deleting',  label: 'Deleting the apps', note: 'Then re-downloading within the week' },
        { id: 'willpower', label: 'Nothing yet',       note: 'Running on willpower alone' }
      ]
    },
    {
      key: 'friction', multi: false,
      title: 'What is your biggest friction point?',
      caption: 'The one moment the reach actually happens.',
      options: [
        { id: 'quickcheck', label: 'The quick check',   note: 'A notification turns into 30 minutes' },
        { id: 'anxiety',    label: 'The morning grab',  note: 'Phone in hand within 5 minutes of waking' },
        { id: 'switching',  label: 'Context-switching', note: 'Never a clean hour of work' }
      ]
    }
  ];

  var TOTAL_STEPS = QUESTIONS.length + 2; // usage + 3 questions + gate

  var ARCHETYPES = {
    morning: {
      name: 'The Morning Scroller',
      thesis: 'Your day is lost before it starts. The first 20 minutes after waking set your attentional baseline, and you are handing them to an algorithm that has had all night to prepare.',
      analog: ['alarmClock'],
      software: ['screenTime'],
      softwareHow: 'Schedule a Sleep Focus that ends 45 minutes after your alarm, not at it.',
      experiment: 'Seven mornings where the phone is not touched until you are dressed.'
    },
    deepwork: {
      name: 'The Context Switcher',
      thesis: 'You do not have an attention problem, you have a recovery problem. Every pickup costs you roughly 23 minutes of re-immersion, which is why your good hours never feel good.',
      analog: ['deskTimer'],
      software: ['appBlocker'],
      softwareHow: 'One notification sweep: everything off except calls and calendar.',
      experiment: 'Two 50-minute blocks a day where the phone is in another room entirely.'
    },
    latenight: {
      name: 'The Doomscroller',
      thesis: 'The late loop is the hardest to break because it is not seeking pleasure, it is avoiding the end of the day. Bedtime scrolling is procrastinating sleep, and it compounds into the morning.',
      analog: ['alarmClock', 'eInkReader'],
      software: ['screenTime'],
      softwareHow: 'A hard downtime at 22:00 with the passcode handed to someone else for a week.',
      experiment: 'Decide tomorrow before you sleep, so the phone has no job at midnight.'
    },
    allday: {
      name: 'The Ambient Drifter',
      thesis: 'There is no single trap to disarm because the phone has absorbed every gap in your day: the queue, the lift, the walk, the pause between two tasks. The fix is not restriction, it is replacement.',
      analog: ['eInkReader'],
      software: ['greyscale'],
      softwareHow: 'Greyscale on a shortcut, so colour becomes a deliberate choice.',
      experiment: 'Name the three gaps you reach in, and pre-decide what fills each one.'
    }
  };

  /* Priority when several windows are selected. "All day" always wins:
     picking it alongside anything else is itself the diagnosis. */
  var WINDOW_PRIORITY = ['allday', 'morning', 'latenight', 'deepwork'];
  var WINDOW_LABELS = {
    morning: 'mornings', deepwork: 'the work day',
    latenight: 'late nights', allday: 'the whole day'
  };

  function pickArchetype(windows) {
    if (!windows || !windows.length) return null;
    if (windows.length >= 3) return ARCHETYPES.allday;
    for (var i = 0; i < WINDOW_PRIORITY.length; i++) {
      if (windows.indexOf(WINDOW_PRIORITY[i]) !== -1) return ARCHETYPES[WINDOW_PRIORITY[i]];
    }
    return ARCHETYPES[windows[0]];
  }

  var FAILURE_NOTES = {
    blockers:  'Blockers failed because they punish the symptom. You defeated them the same way twice, which is exactly when friction stops working.',
    distance:  'Distance failed because it had no replacement attached. An empty twenty minutes is worse than a scrolled one, so the phone came back.',
    deleting:  'Deleting failed because the reflex is not loyal to the app. It moved next door within four days, probably to something you do not even enjoy.',
    willpower: 'Willpower has not failed yet because it has not been tested against a system that runs continuous experiments on you. Start with structure, not resolve.'
  };

  var FRICTION_FIRST_MOVE = {
    quickcheck: 'Kill the badge, not the app. Unread counts manufacture a debt your brain insists on paying.',
    anxiety:    'Put something in your hands before the phone is an option. The reach needs a competitor, not a rule.',
    switching:  'Batch the phone into two windows. Nothing ruins an hour like a device that can interrupt it.'
  };

  /* ── State ─────────────────────────────────────────────────────────────── */
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var state = {
    step: 0,            // 0 usage, 1..3 questions, 4 gate
    band: null,
    hours: null,
    answers: { windows: [], failed: [], friction: null },
    email: '',
    optIn: true,
    sending: false,
    error: '',
    revealed: false
  };

  var root = document.getElementById('diagnostic');
  if (!root) return;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var firstPaint = true;

  /* ── Tiny DOM helper ───────────────────────────────────────────────────── */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function tickSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 10 8');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M1 4l2.5 2.5L9 1');
    path.setAttribute('stroke', '#FFFFFF');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function optionCard(name, opt, checked, multi, onToggle) {
    var input = el('input', {
      type: multi ? 'checkbox' : 'radio', name: name, value: opt.id, checked: checked,
      onchange: function () { onToggle(opt.id); }
    });
    var mark = el('span', { class: 'mark' + (multi ? ' square' : ''), 'aria-hidden': 'true' }, [tickSvg()]);
    return el('label', { class: 'opt' }, [
      input,
      el('div', { class: 'box' }, [
        el('div', { class: 'row' }, [el('span', { class: 'name', text: opt.label }), mark]),
        opt.note ? el('p', { class: 'note', text: opt.note }) : null
      ])
    ]);
  }

  function countUp(node, value) {
    if (reduced) { node.textContent = value.toFixed(1); return; }
    var start = null, dur = 900;
    function tick(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      node.textContent = (value * (1 - Math.pow(1 - t, 3))).toFixed(1);
      if (t < 1) requestAnimationFrame(tick);
      else node.textContent = value.toFixed(1);
    }
    node.textContent = '0.0';
    requestAnimationFrame(tick);
  }

  function toolItem(tool) {
    if (!tool) return null;
    var external = tool.href && tool.href !== '#';
    var link = el('a', {
      href: tool.href, rel: 'sponsored noopener noreferrer',
      target: external ? '_blank' : null, text: tool.name
    });
    if (tool.affiliate) link.appendChild(el('span', { class: 'tag', text: 'affiliate' }));
    return el('li', {}, [link, el('p', { text: tool.note })]);
  }

  /* ── Submission ────────────────────────────────────────────────────────── */
  function submit() {
    var payload = {
      email: state.email.trim(),
      optIn: state.optIn,
      answers: {
        hoursPerDay: state.hours, band: state.band,
        windows: state.answers.windows, failed: state.answers.failed, friction: state.answers.friction
      },
      result: {
        yearsLost: Number(yearsLost(state.hours).toFixed(2)),
        archetype: (pickArchetype(state.answers.windows) || {}).name
      }
    };
    if (!ENDPOINT) return new Promise(function (r) { setTimeout(r, 500); }); // demo mode
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('That did not go through. Try again in a moment.');
      return res;
    });
  }

  /* ── Result, built once and expanded in place ──────────────────────────── */
  function buildResult() {
    var a = pickArchetype(state.answers.windows);
    var years = yearsLost(state.hours);
    var wrap = el('div', {});

    var num = el('span', { class: 'num', text: years.toFixed(1) });
    wrap.appendChild(el('div', { class: 'result-stat' }, [
      el('p', { class: 'eyebrow', text: 'Lifetime impact' }),
      el('p', { class: 'lead', html: 'At <b>' + state.hours.toFixed(1) + '</b> hours a day, you are projected to spend' }),
      el('p', { class: 'big' }, [num, el('span', { class: 'unit', text: 'years' })]),
      el('p', { class: 'lead', text: 'of your life staring at a screen.' }),
      el('p', { class: 'foot-note', text:
        'Assumes ' + YEARS_REMAINING + ' years remaining and today’s average holding. ' +
        (state.hours * 7).toFixed(0) + ' hours a week, ' + ((state.hours * 365) / 24).toFixed(0) + ' days a year.' })
    ]));

    var because = null;
    if (state.answers.failed.length) {
      because = el('div', { class: 'because' }, state.answers.failed.map(function (id) {
        return el('p', { text: FAILURE_NOTES[id] });
      }));
    }
    wrap.appendChild(el('div', { class: 'block' }, [
      el('p', { class: 'eyebrow', style: 'color: var(--faint)', text: 'Your archetype' }),
      el('h3', { text: a.name }),
      state.answers.windows.length > 1
        ? el('p', { class: 'alsoflag', text:
            'You flagged ' + state.answers.windows.map(function (w) { return WINDOW_LABELS[w]; }).join(', ') +
            ' — we built the stack around the one that costs the most.' })
        : null,
      el('p', { class: 'body', text: a.thesis }),
      because
    ]));

    var analog = a.analog.map(function (id) { return TOOLS[id]; });
    var software = a.software.map(function (id) { return TOOLS[id]; });
    var hasAffiliate = analog.concat(software).some(function (t) { return t && t.affiliate; });

    var stack = el('div', { class: 'block plain' }, [
      el('p', { class: 'eyebrow', style: 'color: var(--faint)', text: 'Your focus stack' }),
      el('p', { class: 'kind', text: 'Analog' }),
      el('ul', { class: 'tools' }, analog.map(toolItem)),
      el('p', { class: 'kind', text: 'Software' }),
      el('ul', { class: 'tools' }, software.map(toolItem)),
      el('p', { class: 'howto', text: a.softwareHow }),
      el('p', { class: 'kind', text: 'First move' }),
      el('p', { class: 'move', text: state.answers.friction ? FRICTION_FIRST_MOVE[state.answers.friction] : a.experiment }),
      el('p', { class: 'kind', text: 'This week' }),
      el('p', { class: 'move', text: a.experiment }),
      hasAffiliate ? el('p', { class: 'disclosure', text:
        'Links marked affiliate earn us a commission. They do not change what we recommend, and the free options above are listed first where a free option is the better answer.' })
        /* [PLACEHOLDER: link your full disclosure page here.] */
        : null
    ]);
    wrap.appendChild(stack);

    /* [PLACEHOLDER: the rest of the article. Same copy as the React build's
       default gatedArticle — keep the two in step.] */
    wrap.appendChild(el('div', { class: 'article' }, [
      el('p', { class: 'eyebrow', style: 'color: var(--faint)', text: 'The rest of the issue' }),
      el('p', { text: 'The standard advice — use less, be present, try harder — fails for a structural reason. You are not competing against your own weakness. You are competing against an adaptive system, running continuous experiments, with a feedback loop measured in milliseconds and a budget measured in billions.' }),
      el('p', { text: 'Which is why the stack above is ordered the way it is. The analog object comes first because it is the only part the platforms cannot update around. The software setting comes second because it is free and reversible. The experiment comes last because a week of evidence about yourself beats a year of resolutions.' })
    ]));

    return { node: wrap, count: function () { countUp(num, years); } };
  }

  /* ── Render ────────────────────────────────────────────────────────────── */
  function render() {
    var stepNo = Math.min(state.step + 1, TOTAL_STEPS);
    var pct = state.revealed ? 100 : (state.step / TOTAL_STEPS) * 100;

    root.textContent = '';

    root.appendChild(el('div', { class: 'meta' }, [
      el('span', { class: 'label', text: 'The Focus Stack Diagnostic' }),
      el('span', { class: 'count', text: state.revealed ? 'Complete' : 'Step ' + stepNo + ' of ' + TOTAL_STEPS })
    ]));
    var fill = el('div', {});
    root.appendChild(el('div', {
      class: 'track', role: 'progressbar', 'aria-label': 'Quiz progress',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct))
    }, [fill]));
    requestAnimationFrame(function () { fill.style.width = pct + '%'; });

    var heading = null;

    /* ── The reveal: no navigation, the card expands in place ───────────── */
    if (state.revealed) {
      root.appendChild(el('div', { class: 'unlocked' }, [
        el('span', { html: 'Unlocked. Issue No. 01 is on its way to <b>' + state.email.trim() + '</b>.' })
      ]));
      var built = buildResult();
      var reveal = el('div', { class: 'reveal' }, [el('div', {}, [built.node])]);
      root.appendChild(reveal);
      requestAnimationFrame(function () {
        reveal.classList.add('open');
        built.count();
      });
      setTimeout(function () {
        reveal.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      }, 220);
      firstPaint = false;
      return;
    }

    var step = el('div', { class: 'step' });
    root.appendChild(step);
    requestAnimationFrame(function () { step.classList.add('in'); });

    if (state.step === 0) {
      heading = el('h2', { class: 'q', tabIndex: -1, text: 'How many hours a day do you average on your phone?' });
      step.appendChild(heading);
      step.appendChild(el('p', { class: 'sub', text: 'Screen Time lives in Settings if you want the real number. Most people guess low.' }));

      var grid = el('div', { class: 'grid two' }, USAGE_BANDS.map(function (b) {
        return optionCard('usage', b, state.band === b.id, false, function () {
          state.band = b.id;
          state.hours = b.hours;
          render();
        });
      }));
      step.appendChild(el('fieldset', {}, [el('legend', { class: 'sr-only', text: 'Daily phone hours' }), grid]));

      if (state.hours !== null) {
        var out = el('output', { text: state.hours.toFixed(1) + ' hrs / day' });
        var live = el('p', { class: 'live' });
        var paintLive = function () {
          live.innerHTML = 'That is <b>' + (state.hours * 7).toFixed(0) + ' hours</b> a week — about <b>' +
            ((state.hours * 365) / 24).toFixed(0) + ' days</b> a year.';
        };
        paintLive();
        var range = el('input', {
          type: 'range', min: '1', max: '12', step: '0.5', value: String(state.hours), id: 'fsd-hours',
          oninput: function (e) {
            state.hours = Number(e.target.value);
            out.textContent = state.hours.toFixed(1) + ' hrs / day';
            paintLive();
          }
        });
        step.appendChild(el('div', { class: 'tune' }, [
          el('div', { class: 'top' }, [el('label', { for: 'fsd-hours', text: 'Fine-tune' }), out]),
          range, live
        ]));
      }
    }

    else if (state.step <= QUESTIONS.length) {
      var q = QUESTIONS[state.step - 1];
      var selected = state.answers[q.key];
      heading = el('h2', { class: 'q', tabIndex: -1, text: q.title });
      step.appendChild(heading);
      step.appendChild(el('p', { class: 'sub' }, [
        q.caption,
        q.multi ? el('span', { class: 'hint', text: ' (Choose as many as apply.)' }) : null
      ]));
      var opts = el('div', { class: 'grid' + (q.options.length > 3 ? ' two' : '') }, q.options.map(function (o) {
        var checked = q.multi ? selected.indexOf(o.id) !== -1 : selected === o.id;
        return optionCard(q.key, o, checked, q.multi, function (id) {
          if (!q.multi) { state.answers[q.key] = id; }
          else {
            var list = state.answers[q.key];
            var at = list.indexOf(id);
            state.answers[q.key] = at === -1 ? list.concat([id]) : list.filter(function (x) { return x !== id; });
          }
          render();
        });
      }));
      step.appendChild(el('fieldset', {}, [el('legend', { class: 'sr-only', text: q.title }), opts]));
    }

    else {
      heading = el('h2', { class: 'q', tabIndex: -1, text: 'Your Custom Focus Stack is Ready.' });
      step.appendChild(heading);
      step.appendChild(el('p', { class: 'sub', text:
        'Enter your email to unlock your personalised protocol, see your lifetime screen impact, and get Unscroll No. 01 delivered straight to your inbox.' }));

      var email = el('input', {
        class: 'field', type: 'email', id: 'fsd-email', placeholder: 'you@example.com',
        value: state.email, autocomplete: 'email', inputMode: 'email', required: true,
        'aria-invalid': state.error ? 'true' : 'false',
        'aria-describedby': state.error ? 'fsd-email-error' : null,
        oninput: function (e) { state.email = e.target.value; }
      });
      var check = el('input', {
        type: 'checkbox', checked: state.optIn,
        onchange: function (e) { state.optIn = e.target.checked; }
      });
      var button = el('button', {
        class: 'btn', type: 'submit', disabled: state.sending,
        text: state.sending ? 'Building your stack…' : 'Reveal My Lifetime Impact & Custom Stack'
      });

      step.appendChild(el('form', {
        noValidate: true,
        onsubmit: function (e) {
          e.preventDefault();
          if (!EMAIL_RE.test(state.email.trim())) {
            state.error = 'That email looks incomplete.';
            render();
            return;
          }
          state.error = '';
          state.sending = true;
          render();
          submit().then(function () {
            state.sending = false;
            state.revealed = true;   // inline — the page never navigates
            render();
          }).catch(function (err) {
            state.sending = false;
            state.error = (err && err.message) || 'Something went wrong. Try again.';
            render();
          });
        }
      }, [
        el('label', { class: 'sr-only', for: 'fsd-email', text: 'Email address' }),
        email,
        el('label', { class: 'check' }, [
          check,
          el('span', { html: 'Send me the weekly Unscroll dispatch (science, tools, and open R&amp;D logs). Unsubscribe anytime.' })
        ]),
        state.error ? el('p', { class: 'err', id: 'fsd-email-error', role: 'alert', text: state.error }) : null,
        button,
        el('p', { class: 'fineprint', text: 'No spam. One click to leave. We sell no hardware and take no app sponsorships.' })
      ]));
    }

    /* navigation */
    var back = el('button', {
      class: 'back', type: 'button', text: '← Back', hidden: state.step === 0,
      onclick: function () { state.step = Math.max(0, state.step - 1); render(); }
    });
    if (state.step === TOTAL_STEPS - 1) {
      root.appendChild(el('div', { class: 'nav', style: 'justify-content: flex-start' }, [back]));
    } else {
      var q2 = state.step === 0 ? null : QUESTIONS[state.step - 1];
      var canAdvance = state.step === 0
        ? state.hours !== null
        : (q2.multi ? state.answers[q2.key].length > 0 : Boolean(state.answers[q2.key]));
      root.appendChild(el('div', { class: 'nav' }, [
        back,
        el('button', {
          class: 'next', type: 'button', text: 'Continue', disabled: !canAdvance,
          onclick: function () { state.step += 1; render(); }
        })
      ]));
    }

    /* Keep keyboard and screen-reader users with the content, but never yank
       the viewport on first paint. */
    if (!firstPaint && heading) heading.focus();
    firstPaint = false;
  }

  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  render();
})();
