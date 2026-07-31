// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview Renderer shell: routes between the pages and fans main.js's
 * two messages out to them.
 *
 * The renderer owns no hardware and no truth. main.js pushes `state` when the
 * config or the display list changes and `tick` on every sensor reading, and
 * every control sends an action back -- which is why no page keeps a copy of
 * the config to be kept in sync. The one exception is the curve being dragged,
 * which is unsaved by definition and lives in ui.js.
 */

import { $, api, curve, editing } from './ui.js';
import * as setup from './setup.js';
import { calibratePage } from './pages/calibrate.js';
import { extradimPage } from './pages/extradim.js';
import { homePage } from './pages/home.js';
import { settingsPage } from './pages/settings.js';

/** @const {!Array<!Object>} in sidebar order. */
const PAGES = [homePage, calibratePage, extradimPage, settingsPage];

/** @type {?Object} the most recent `state` push; null until the first one. */
let state = null;

/** @type {!Object} */
let current = homePage;

/**
 * Shows one page and hides the rest.
 * @param {string} id
 */
function go(id) {
  current = PAGES.find((p) => p.id === id) ?? homePage;

  for (const page of PAGES) {
    const on = page === current;
    $(`page-${page.id}`).hidden = !on;
    const button = document.querySelector(`.nav[data-page="${page.id}"]`);
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  if (state) current.build(state);
  current.enter?.();
}

for (const button of document.querySelectorAll('.nav')) {
  button.addEventListener('click', () => go(button.dataset.page));
}

// --- the opening animation ---------------------------------------------------

// The desk is cloned from the Home card rather than repeated in the markup, so
// the illustration has exactly one definition to keep in step with the theme.
const splash = $('splash');
$('splash-desk').append(document.querySelector('.desk').cloneNode(true));

function afterSplash() {
  splash.remove();
}

if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  afterSplash(); // the CSS suppresses the animation, so no animationend is coming
} else {
  splash.addEventListener('animationend', (e) => {
    if (e.target === splash) afterSplash();
  });
  // A window that starts hidden to the tray may never composite the animation,
  // and a splash that outlives its own animation is a dead app.
  setTimeout(afterSplash, 4000);
}

// --- main's two messages -----------------------------------------------------

api.onState((next) => {
  const first = state === null;
  state = next;
  document.body.classList.toggle('compact', state.cfg.compact);
  // A curve the user is part-way through editing is the renderer's own; do not
  // stomp it with the saved copy.
  if (!editing.curveDirty) curve.ys = [...state.curveYs];
  setup.state(state);
  current.build(state);

  // Opened straight away rather than after the splash: the splash *fades* out,
  // so whatever is underneath shows through it, and that has to be the wizard
  // and not a half-second flash of the Home screen.
  if (first && !state.cfg.firstRunDone) setup.start();
});

api.onTick((t) => {
  // The wizard is not a routed page, so it needs its own fan-out.
  setup.tick(t);
  current.tick?.(t);
});

go('home');
