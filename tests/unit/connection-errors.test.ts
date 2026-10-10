import { expect, test } from 'bun:test';
import { connectionErrorMessage, localHttpBlockedHost } from '../../src/lib/connection-errors';

test('opaque failures from an HTTPS page to loopback HTTP get actionable browser guidance', () => {
  for (const host of ['127.0.0.1', '127.2.3.4', 'localhost', 'localhost.', 'worker.localhost', '[::1]']) {
    const message = connectionErrorMessage(new TypeError(`Load failed (${host}:9137)`), `http://${host}:9137`, 'https:');
    expect(message).toContain('Safari can block');
    expect(message).toContain('desktop Chrome');
    expect(message).toContain('local server is running');
  }
});

test('HTTPS workers, remote hosts and local HTTP pages do not get the loopback warning', () => {
  for (const [service, protocol] of [
    ['https://localhost:9137', 'https:'], ['http://localhost:9137', 'http:'],
    ['http://example.com', 'https:'], ['http://localhost.example.com', 'https:'],
    ['http://127.0.0.1.example.com', 'https:'], ['not a URL', 'https:'],
  ]) expect(connectionErrorMessage(new TypeError('Load failed'), service, protocol)).toBe('Load failed');
});

test('specific server errors, cancellation and timeouts retain their original meaning', () => {
  for (const error of [new Error('HTTP 401: sign-in required'), new Error('Invalid report'),
    new DOMException('The operation was aborted.', 'AbortError'), new DOMException('Timed out', 'TimeoutError'),
    Object.assign(new Error('Load failed'), { errorCode: 'PERMISSION_DENIED' }),
  ]) expect(connectionErrorMessage(error, 'http://127.0.0.1:9137', 'https:')).toBe(error.message);
  expect(connectionErrorMessage(new TypeError('Load failed'), 'http://user:secret@127.0.0.1:9137/?token=private', 'https:')).not.toMatch(/secret|private/);
});

test('the loopback guidance is recognised for display, other messages are not', () => {
  expect(localHttpBlockedHost(connectionErrorMessage(new TypeError('Load failed'), 'http://127.0.0.1:9137', 'https:'))).toBe('127.0.0.1:9137');
  expect(localHttpBlockedHost(connectionErrorMessage(new TypeError('Load failed'), 'http://[::1]:9137', 'https:'))).toBe('[::1]:9137');
  for (const message of ['Load failed', 'HTTP 401: sign-in required', '', undefined]) expect(localHttpBlockedHost(message)).toBeNull();
});
