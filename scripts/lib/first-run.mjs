/* ============================================================================
   FSN — FIRST-RUN OVERLAY DISMISSAL (browser-check harness only)

   Every headless check that clicks anything has to get past the same three
   first-run surfaces, and each one of them swallows clicks while it is up:

     #profilePicker  the team-profile chooser, modal, opens on the first live
                     payload
     #ftuModal       the first-run walkthrough, opened by maybeShowFtu() on a
                     450ms timer after boot
     setup screen    a full-screen takeover at z-index 85 over a tab bar at 60,
                     so while it is open a tab click lands on the Setup card

   A single `if (open) click()` races the FTU timer: the modal can be shut when
   asked and open by the time the next click goes out, and its backdrop then
   eats every click for the rest of the run. That is the whole of the click
   timeouts that kept `npm run verify` red. So poll instead, and require two
   consecutive clean passes before declaring the screen clear.

   This module is test harness only. It is not loaded by index.html and it must
   not reach into application state: it dismisses each surface the way a reader
   does, by clicking it.
   ========================================================================= */

const OPEN_STATE = () => ({
  profile: (document.getElementById('profilePicker') || {}).dataset?.open === 'true',
  ftu: (document.getElementById('ftuModal') || {}).dataset?.open === 'true',
});

/* Whether the Setup takeover is the active screen. Seeding LeagueData directly
   does not close it the way connecting a league does, so it has to be closed
   explicitly before the tab bar is clickable. */
export async function setupIsOpen(page) {
  return await page.evaluate(() =>
    (document.querySelector('.screen[data-screen="setup"]') || {}).dataset?.active === 'true');
}

/* Poll #profilePicker and #ftuModal until both stay shut across two passes.
   Returns what was dismissed so a caller can report it. */
export async function dismissModals(page, opts = {}) {
  const attempts = opts.attempts ?? 12;
  const settle = opts.settle ?? 400;
  const dismissed = { profile: 0, ftu: 0 };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const open = await page.evaluate(OPEN_STATE);
    if (!open.profile && !open.ftu) {
      /* Two clean passes: the FTU timer may not have fired yet. */
      await page.waitForTimeout(settle);
      const still = await page.evaluate(OPEN_STATE);
      if (!still.profile && !still.ftu) return dismissed;
      continue;
    }
    if (open.profile) { await page.click('#profileGuest'); dismissed.profile += 1; }
    else if (open.ftu) { await page.click('#ftuSkip'); dismissed.ftu += 1; }
    await page.waitForTimeout(settle);
  }

  const open = await page.evaluate(OPEN_STATE);
  if (open.profile || open.ftu) {
    throw new Error('[first-run] overlays still open after ' + attempts + ' attempts: ' +
      JSON.stringify(open) + ' — the check below would have timed out on an intercepted click');
  }
  return dismissed;
}

/* Close the Setup takeover the way a reader would, if it is showing. */
export async function dismissSetup(page, opts = {}) {
  const settle = opts.settle ?? 500;
  if (!(await setupIsOpen(page))) return false;
  await page.click('#setupClose');
  await page.waitForTimeout(settle);
  return true;
}

/* The whole first-run gauntlet: modals, then Setup, then modals once more —
   closing Setup can itself reveal a walkthrough that was queued behind it.
   Returns { profile, ftu, setup } describing what was actually dismissed. */
export async function dismissFirstRun(page, opts = {}) {
  const first = await dismissModals(page, opts);
  const setup = opts.closeSetup === false ? false : await dismissSetup(page, opts);
  const second = setup ? await dismissModals(page, opts) : { profile: 0, ftu: 0 };
  return {
    profile: first.profile + second.profile,
    ftu: first.ftu + second.ftu,
    setup,
  };
}
