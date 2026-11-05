import { describe, expect, test } from 'bun:test';
import { isOutsideApp } from '../../src/lib/evidence/link-refusal';

const current = new URL('https://cupola.example/v1.2.3/evidence?evidence_report=a');
const base = '/v1.2.3/';
const outside = (href: string) => isOutsideApp(new URL(href, current), current, base);

describe('isOutsideApp', () => {
  test('refuses a same-origin path outside the app', () => {
    expect(outside('/somewhere/else')).toBe(true);
    expect(outside('/')).toBe(true);
    // An older release's path is not this app, and a prefix match alone must not pass it.
    expect(outside('/v1.2.30/evidence')).toBe(true);
  });

  test('allows the app and the current page', () => {
    expect(outside('/v1.2.3/evidence?evidence_report=b')).toBe(false);
    expect(outside('/v1.2.3/evidence?fullscreen=')).toBe(false);
  });

  test('leaves other origins alone', () => {
    expect(outside('https://example.com/ticket/42')).toBe(false);
  });

  test('a root-hosted app has no outside', () => {
    expect(isOutsideApp(new URL('https://cupola.example/somewhere'), new URL('https://cupola.example/evidence'), '/')).toBe(false);
  });
});
