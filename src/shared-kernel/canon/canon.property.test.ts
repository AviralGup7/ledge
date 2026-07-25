// E1-T06 · completion criteria: idempotence property + scheme allowlist + never-throw.
import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { canonicalize } from './index.js';

const arbScheme = fc.constantFrom('http', 'https');
const arbHost = fc.domain();
const arbPairChar = fc.stringMatching(/^[A-Za-z0-9._~-]{1,12}$/);
const arbPath = fc.array(fc.webSegment(), { maxLength: 4 });
const arbQuery = fc.array(fc.tuple(arbPairChar, arbPairChar), { maxLength: 6 });
const arbFragment = fc.option(fc.string({ maxLength: 12 }), { nil: null });

const arbHttpUrl = fc
  .tuple(arbScheme, arbHost, arbPath, arbQuery, arbFragment)
  .map(([scheme, host, path, query, fragment]) => {
    const p = path.length > 0 ? `/${path.join('/')}` : '';
    const q = query.length > 0 ? `?${query.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    const f = fragment !== null ? `#${encodeURIComponent(fragment)}` : '';
    return `${scheme}://${host}${p}${q}${f}`;
  });

describe('E1-T06 property suite', () => {
  it('P1 idempotence: canon(canon(x)) === canon(x) for arbitrary http(s) URLs', () => {
    fc.assert(
      fc.property(arbHttpUrl, (raw) => {
        const once = canonicalize(raw);
        if (!once.schemeOk) return true;
        const twice = canonicalize(once.canonForm);
        return twice.canonForm === once.canonForm && twice.canonHash === once.canonHash;
      }),
    );
  });

  it('P2 never throws: arbitrary strings produce a well-formed result', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const r = canonicalize(raw);
        return (
          typeof r.canonForm === 'string' &&
          /^[0-9a-f]{16}$/.test(r.canonHash) &&
          typeof r.schemeOk === 'boolean'
        );
      }),
    );
  });

  it('P3 scheme allowlist: non-http(s) schemes always schemeOk:false', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('javascript', 'data', 'file', 'ftp', 'chrome', 'about', 'mailto'),
        arbHost,
        (scheme, host) => {
          const r = canonicalize(`${scheme}://${host}/`);
          return r.schemeOk === false && r.canonForm === `${scheme}://${host}/`;
        },
      ),
    );
  });

  it('P4 fragments preserved verbatim through canonicalization', () => {
    fc.assert(
      fc.property(arbHttpUrl, (raw) => {
        const r = canonicalize(raw);
        if (!r.schemeOk) return true;
        const hashIndex = raw.indexOf('#');
        if (hashIndex === -1) return true;
        const fragment = raw.slice(hashIndex);
        return fragment === '#' ? !r.canonForm.includes('#') : r.canonForm.endsWith(fragment);
      }),
    );
  });
});
