/* ───────────────────────────────────────────────────────────────────────────
   The Focus Stack Diagnostic — vanilla build for the static site.

   Mirrors focus-stack-quiz/FocusStackDiagnostic.jsx (the Next.js version):
   same questions, same math, same archetypes, same copy. If you edit one,
   edit the other. All of the content lives in the maps at the top; the
   rendering below never needs touching to change wording.
─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── The math ────────────────────────────────────────────────────────────
     hours/day x 365 x YEARS_REMAINING / HOURS_PER_YEAR = years of life.
     Both are assumptions, not findings, and the result says so on screen. */
  var HOURS_PER_YEAR = 8760;
  var YEARS_REMAINING = 50;
  function yearsLost(h) { return (h * 365 * YEARS_REMAINING) / HOURS_PER_YEAR; }

  /* [PLACEHOLDER: point this at your list provider. Return a rejected promise
     to show the inline error. Leave as null for demo mode.] */
  var ENDPOINT = null;

  var USAGE_BANDS = [
    { id: 'light',   label: '~2 hours',   hours: 2,   note: 'Well under average' },
    { id: 'typical', label: '3–4 hours',  hours: 3.5, note: 'The global average' },
    { id: 'heavy',   label: '5–6 hours',  hours: 5.5, note: 'Above average' },
    { id: 'severe',  label: '7+ hours',   hours: 7.5, note: 'Top decile' }
  ];

  var QUESTIONS = [
    {
      key: 'window',
      title: 'When do you do your worst scrolling?',
      caption: 'Pick the window that costs you the most.',
      options: [
        { id: 'morning',   label: 'Morning',    note: 'In bed, right after waking up' },
        { id: 'deepwork',  label: 'Deep work',  note: 'Mid-day slumps and task gaps' },
        { id: 'latenight', label: 'Late night', note: 'Bedtime doomscrolling' },
        { id: 'allday',    label: 'All day',    note: 'Unstructured, no clear pattern' }
      ]
    },
    {
      key: 'failed',
      title: 'What have you already tried that failed?',
      caption: 'No wrong answer — this is how we pick what to skip.',
      options: [
        { id: 'blockers',  label: 'App blockers',      note: 'Opal, Freedom, Screen Time limits' },
        { id: 'distance',  label: 'Physical distance', note: 'Another room, a lockbox, a drawer' },
        { id: 'deleting',  label: 'Deleting the apps', note: 'Then re-downloading within the week' },
        { id: 'willpower', label: 'Nothing yet',       note: 'Running on willpower alone' }
      ]
    },
    {
      key: 'friction',
      title: 'What is your biggest friction point?',
      caption: 'The moment the reach actually happens.',
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
      analog: 'A $12 alarm clock, and the charger moved to the kitchen tonight.',
      software: 'Schedule a Sleep Focus that ends 45 minutes after your alarm, not at it.',
      experiment: 'Seven mornings where the phone is not touched until you are dressed.'
    },
    deepwork: {
      name: 'The Context Switcher',
      thesis: 'You do not have an attention problem, you have a recovery problem. Every pickup costs you roughly 23 minutes of re-immersion, which is why your good hours never feel good.',
      analog: 'A physical timer on the desk and the phone face-down in a drawer, not a pocket.',
      software: 'One notification sweep: everything off except calls and calendar.',
      experiment: 'Two 50-minute blocks a day where the phone is in another room entirely.'
    },
    latenight: {
      name: 'The Doomscroller',
      thesis: 'The late loop is the hardest to break because it is not seeking pleasure, it is avoiding the end of the day. Bedtime scrolling is procrastinating sleep, and it compounds into the morning.',
      analog: 'A paper book on the pillow and the phone charging outside the bedroom.',
      software: 'A hard downtime at 22:00 with the passcode handed to someone else for a week.',
      experiment: 'Decide tomorrow before you sleep, so the phone has no job at midnight.'
    },
    allday: {
      name: 'The Ambient Drifter',
      thesis: 'There is no single trap to disarm because the phone has absorbed every gap in your day: the queue, the lift, the walk, the pause between two tasks. The fix is not restriction, it is replacement.',
      analog: 'One object you carry instead — a notebook, a Kindle, a camera, headphones with no feed.',
      software: 'Greyscale on a shortcut, so colour becomes a deliberate choice.',
      experiment: 'Name the three gaps you reach in, and pre-decide what fills each one.'
    }
  };

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
    step: 0,            // 0 usage, 1..3 questions, 4 gate, 5 result
    band: null,
    hours: null,
    answers: { window: null, failed: null, friction: null },
    email: '',
    optIn: true,
    sending: false,
    error: ''
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

  function optionCard(name, opt, checked, onPick) {
    var input = el('input', {
      type: 'radio', name: name, value: opt.id, checked: checked,
      onchange: function () { onPick(opt.id); }
    });
    return el('label', { class: 'opt' }, [
      input,
      el('div', { class: 'box' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'name', text: opt.label }),
          el('span', { class: 'dot', 'aria-hidden': 'true' })
        ]),
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

  /* ── Submission ────────────────────────────────────────────────────────── */
  function submit() {
    var payload = {
      email: state.email.trim(),
      optIn: state.optIn,
      answers: {
        hoursPerDay: state.hours, band: state.band,
        window: state.answers.window, failed: state.answers.failed, friction: state.answers.friction
      },
      result: {
        yearsLost: Number(yearsLost(state.hours).toFixed(2)),
        archetype: ARCHETYPES[state.answers.window].name
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

  /* ── Render ────────────────────────────────────────────────────────────── */
  function render() {
    var isResult = state.step === TOTAL_STEPS;
    var stepNo = Math.min(state.step + 1, TOTAL_STEPS);
    var pct = isResult ? 100 : (state.step / TOTAL_STEPS) * 100;

    root.textContent = '';

    /* header */
    root.appendChild(el('div', { class: 'meta' }, [
      el('span', { class: 'label', text: 'The Focus Stack Diagnostic' }),
      el('span', { class: 'count', text: isResult ? 'Complete' : 'Step ' + stepNo + ' of ' + TOTAL_STEPS })
    ]));
    var fill = el('div', {});
    root.appendChild(el('div', {
      class: 'track', role: 'progressbar', 'aria-label': 'Quiz progress',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct))
    }, [fill]));
    requestAnimationFrame(function () { fill.style.width = pct + '%'; });

    var step = el('div', { class: 'step' });
    root.appendChild(step);
    requestAnimationFrame(function () { step.classList.add('in'); });

    var heading;

    if (state.step === 0) {
      heading = el('h2', { class: 'q', tabIndex: -1, text: 'How many hours a day do you average on your phone?' });
      step.appendChild(heading);
      step.appendChild(el('p', { class: 'sub', text: 'Screen Time lives in Settings if you want the real number. Most people guess low.' }));

      var grid = el('div', { class: 'grid two' }, USAGE_BANDS.map(function (b) {
        return optionCard('usage', b, state.band === b.id, function (id) {
          state.band = id;
          state.hours = b.hours;
          render();
        });
      }));
      step.appendChild(el('fieldset', {}, [el('legend', { class: 'sr-only', text: 'Daily phone hours' }), grid]));

      if (state.hours !== null) {
        var out = el('output', { class: 'num', text: state.hours.toFixed(1) + ' hrs / day' });
        var live = el('p', { class: 'live' });
        function paintLive() {
          live.innerHTML = 'That is <b>' + (state.hours * 7).toFixed(0) + ' hours</b> a week — about <b>' +
            ((state.hours * 365) / 24).toFixed(0) + ' days</b> a year.';
        }
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
      heading = el('h2', { class: 'q', tabIndex: -1, text: q.title });
      step.appendChild(heading);
      step.appendChild(el('p', { class: 'sub', text: q.caption }));
      var opts = el('div', { class: 'grid' + (q.options.length > 3 ? ' two' : '') }, q.options.map(function (o) {
        return optionCard(q.key, o, state.answers[q.key] === o.id, function (id) {
          state.answers[q.key] = id;
          render();
        });
      }));
      step.appendChild(el('fieldset', {}, [el('legend', { class: 'sr-only', text: q.title }), opts]));
    }

    else if (!isResult) {
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

      var form = el('form', {
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
            state.step = TOTAL_STEPS;
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
      ]);
      step.appendChild(form);
    }

    else {
      var a = ARCHETYPES[state.answers.window];
      var years = yearsLost(state.hours);
      heading = el('h2', { class: 'q sr-only', tabIndex: -1, text: 'Your result' });
      step.appendChild(heading);

      var num = el('span', { class: 'num', text: years.toFixed(1) });
      step.appendChild(el('div', { class: 'result-stat' }, [
        el('p', { class: 'eyebrow', text: 'Lifetime impact' }),
        el('p', { class: 'lead', html: 'At <b>' + state.hours.toFixed(1) + '</b> hours a day, you are projected to spend' }),
        el('p', { class: 'big' }, [num, el('span', { class: 'unit', text: 'years' })]),
        el('p', { class: 'lead', text: 'of your life staring at a screen.' }),
        el('p', { class: 'foot-note', text:
          'Assumes ' + YEARS_REMAINING + ' years remaining and today’s average holding. ' +
          (state.hours * 7).toFixed(0) + ' hours a week, ' + ((state.hours * 365) / 24).toFixed(0) + ' days a year.' })
      ]));
      countUp(num, years);

      step.appendChild(el('div', { class: 'block' }, [
        el('p', { class: 'eyebrow', style: 'color: var(--faint)', text: 'Your archetype' }),
        el('h3', { text: a.name }),
        el('p', { class: 'body', text: a.thesis }),
        state.answers.failed ? el('p', { class: 'because', text: FAILURE_NOTES[state.answers.failed] }) : null
      ]));

      step.appendChild(el('div', { class: 'block' }, [
        el('p', { class: 'eyebrow', style: 'color: var(--faint)', text: 'Your focus stack' }),
        el('dl', { class: 'stack' }, [
          el('dt', { text: 'Analog' }),      el('dd', { text: a.analog }),
          el('dt', { text: 'Software' }),    el('dd', { text: a.software }),
          el('dt', { text: 'First move' }),  el('dd', { text: state.answers.friction ? FRICTION_FIRST_MOVE[state.answers.friction] : a.experiment }),
          el('dt', { text: 'This week' }),   el('dd', { text: a.experiment })
        ])
      ]));

      /* [PLACEHOLDER: point this at your protocol / tool-stack page.] */
      step.appendChild(el('a', { class: 'btn', href: 'index.html', text: 'View my full protocol & tool stack' }));
      step.appendChild(el('p', { class: 'fineprint', text: 'Issue No. 01 is on its way to ' + state.email.trim() + '.' }));
    }

    /* navigation */
    if (!isResult) {
      var back = el('button', {
        class: 'back', type: 'button', text: '← Back', hidden: state.step === 0,
        onclick: function () { state.step = Math.max(0, state.step - 1); render(); }
      });
      if (state.step === TOTAL_STEPS - 1) {
        root.appendChild(el('div', { class: 'nav', style: 'justify-content: flex-start' }, [back]));
      } else {
        var canAdvance = state.step === 0 ? state.hours !== null : Boolean(state.answers[QUESTIONS[state.step - 1].key]);
        root.appendChild(el('div', { class: 'nav' }, [
          back,
          el('button', {
            class: 'next', type: 'button', text: 'Continue', disabled: !canAdvance,
            onclick: function () { state.step += 1; render(); }
          })
        ]));
      }
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
