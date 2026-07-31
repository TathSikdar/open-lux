// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview Plumbing every page in the renderer shares: the IPC bridge,
 * two DOM helpers, lux formatting, and the single Curve instance that the
 * Settings editor writes and the ExtraDim preview reads.
 *
 * Nothing here talks to hardware. main.js owns all of that; a page's only way
 * to change anything is `patch()` or one of the `api` calls.
 */

import { Curve } from './core.js';

export { formatLux } from './core.js';

/** The preload bridge. See preload.cjs for the exact surface. */
export const api = window.openlux;

/**
 * The curve currently on screen. Shared rather than passed around because the
 * Settings editor and the ExtraDim preview are two views of one object, and a
 * copy would let them disagree mid-drag.
 * @type {!Curve}
 */
export const curve = new Curve();

/**
 * Set while the user is dragging a knot they have not saved. It is the one
 * piece of state the renderer owns, so `state` pushes must not stomp it.
 */
export const editing = { curveDirty: false };

/**
 * @param {string} id
 * @return {!HTMLElement}
 */
export function $(id) {
  return document.getElementById(id);
}

/**
 * Persists a partial config change. main.js merges, saves and pushes `state`
 * back, so there is never a local copy to keep in sync.
 * @param {!Object} changes
 * @return {!Promise<void>}
 */
export function patch(changes) {
  return api.patchConfig(changes);
}

/**
 * A muted explanatory paragraph.
 * @param {string} text
 * @return {!HTMLParagraphElement}
 */
export function note(text) {
  const p = document.createElement('p');
  p.className = 'sub';
  p.textContent = text;
  return p;
}

/**
 * A page of the app.
 * @typedef {{
 *   id: string,
 *   build: function(!Object): void,
 *   tick: (function(!Object): void|undefined),
 *   enter: (function(): void|undefined),
 * }}
 */
export let Page;
