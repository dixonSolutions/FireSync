/**
 * Popover placement.
 *
 * The rule is: centred on the field and below it, then pulled back inside
 * whichever viewport edge it overruns, then flipped above when there is no room
 * below and more room above — with the caret still pointing at the field
 * through all of it. These are the cases where those rules disagree with each
 * other: a field at the very top, one at the very bottom, one hard against a
 * side, and a viewport too small to hold the popover at all.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { placeMenu } from '../src/autofill/overlay.ts';

/** happy-dom reports 0 for clientWidth/clientHeight, so the viewport is set here. */
function setViewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: height,
    configurable: true,
  });
}

function fieldAt(left: number, top: number, width = 300, height = 34): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A host whose height is fixed, standing in for one the menu page has sized. */
function hostOfHeight(height: number): HTMLElement {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  Object.defineProperty(host, 'offsetHeight', { value: height, configurable: true });
  document.body.append(host);
  return host;
}

const px = (value: string): number => Number.parseFloat(value);

describe('placeMenu', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setViewport(1000, 800);
    window.scrollX = 0;
    window.scrollY = 0;
  });

  it('centres the popover on the field and sits below it', () => {
    const host = hostOfHeight(200);
    const placement = placeMenu(fieldAt(300, 100), host);

    expect(placement.side).toBe('below');
    // The field spans 300-600, so its centre is 450 and a 300-wide popover
    // starts at 300 — the same place, because the popover matches the field.
    expect(px(host.style.width)).toBe(300);
    expect(px(host.style.left)).toBe(300);
    expect(px(host.style.top)).toBe(134);
    // The caret points at the field's centre, measured from the popover's edge.
    expect(placement.caret).toBe(150);
  });

  it('flips above a field with no room beneath it', () => {
    const host = hostOfHeight(200);
    const placement = placeMenu(fieldAt(300, 700), host);

    expect(placement.side).toBe('above');
    expect(px(host.style.top)).toBe(500); // field top 700, less the 200 height
  });

  it('stays below when neither side fits but below has more room', () => {
    const host = hostOfHeight(400);
    const placement = placeMenu(fieldAt(300, 300), host);

    expect(placement.side).toBe('below');
  });

  it('slides back inside the left edge and keeps the caret on the field', () => {
    const host = hostOfHeight(200);
    // A narrow field at the very left: centred, the popover would start at -110.
    const placement = placeMenu(fieldAt(2, 100, 40), host);

    expect(px(host.style.left)).toBe(8);
    expect(px(host.style.width)).toBe(260);
    expect(placement.caret).toBe(18); // field centre is 22, clamped off the corner
  });

  it('slides back inside the right edge', () => {
    const host = hostOfHeight(200);
    const placement = placeMenu(fieldAt(940, 100, 40), host);

    expect(px(host.style.left)).toBe(732); // 1000 - 8 - 260
    expect(placement.caret).toBe(228); // still reaches the field's centre at 960
  });

  it('holds the caret off the corner when the field is further out than it reaches', () => {
    const host = hostOfHeight(200);
    // Field centred at 980; the popover's right edge is 992, so pointing at the
    // field exactly would put the caret on the rounded corner.
    const placement = placeMenu(fieldAt(960, 100, 40), host);

    expect(px(host.style.left)).toBe(732);
    expect(placement.caret).toBe(242); // 260 - 18
  });

  it('never grows wider than the viewport allows', () => {
    setViewport(200, 800);
    const host = hostOfHeight(200);
    placeMenu(fieldAt(0, 100, 200), host);

    expect(px(host.style.width)).toBe(184); // 200 - 8 on each side
    expect(px(host.style.left)).toBe(8);
  });

  it('places against the document, not the viewport, on a scrolled page', () => {
    window.scrollX = 40;
    window.scrollY = 1000;
    const host = hostOfHeight(200);
    placeMenu(fieldAt(300, 100), host);

    expect(px(host.style.left)).toBe(340);
    expect(px(host.style.top)).toBe(1134);
  });
});
