import { describe, it, expect } from 'vitest';
import { HttpDkgTransport } from '../../src/transport.js';

/**
 * Regression guard: a DKG_AUTH_TOKEN that arrives carrying the auth.token
 * comment line (e.g. someone does DKG_AUTH_TOKEN=$(cat auth.token)) must not
 * poison the HTTP Authorization header. The comment line contains an em-dash
 * (U+2014), which is > 255 and throws "Cannot convert argument to a ByteString"
 * when fetch builds the header. sanitizeToken strips it to the bare token.
 */
describe('HttpDkgTransport.sanitizeToken', () => {
  const BARE = 'Cax2cphY0Y4iUuPCIlH7fjc8i0kj81TSLJznrAG';

  it('returns a bare token unchanged', () => {
    expect(HttpDkgTransport.sanitizeToken(BARE)).toBe(BARE);
  });

  it('strips the leading comment line (with em-dash) and returns the token', () => {
    const poisoned = `# DKG node API token — treat this like a password\n${BARE}`;
    expect(HttpDkgTransport.sanitizeToken(poisoned)).toBe(BARE);
  });

  it('handles trailing whitespace / blank lines', () => {
    expect(HttpDkgTransport.sanitizeToken(`  ${BARE}  \n\n`)).toBe(BARE);
  });

  it('produces a header value that is valid ASCII (no ByteString error)', () => {
    const poisoned = `# comment — with em-dash\n${BARE}`;
    const tok = HttpDkgTransport.sanitizeToken(poisoned);
    // every char must be <= 255 for a valid HTTP header ByteString
    expect([...tok].every((c) => c.charCodeAt(0) <= 255)).toBe(true);
  });

  it('throws a clear error when nothing but comments remain', () => {
    expect(() => HttpDkgTransport.sanitizeToken('# only a comment\n')).toThrow(/empty after stripping/);
  });
});
