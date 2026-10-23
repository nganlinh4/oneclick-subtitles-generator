// The render refusal vocabulary, checked against the codes Rust actually mints.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { allowedRenderCode, renderFailureMessage } from './renderErrors';

/**
 * The refusal vocabulary is a contract with Rust, and nothing was checking it.
 *
 * `apps/desktop/src-tauri/src/render/refusal.rs` is the only place a render refusal is minted. When
 * it gained three codes for atlas paging, this side did not, and `allowedRenderCode` quietly mapped
 * all three to `nativeRenderFailed` — the generic "could not be completed" sentence. Auditing that
 * turned up five OLDER codes in the same state, and they are the ones a user most needs: a full
 * disk, a lost graphics device, an unreadable source, unusable audio, a scene the compositor
 * refuses. Rust knew exactly what went wrong and the editor said nothing.
 *
 * So the vocabulary is read from the Rust source rather than transcribed. A code added there and not
 * here fails this, which is the only way the two stay in step — a list two files apart drifts by
 * default, and it did.
 */
describe('the render refusal vocabulary matches the one Rust mints', () => {
  const refusalSource = () => readFileSync(
    resolve(__dirname, '..', '..', 'apps/desktop/src-tauri/src/render/refusal.rs'),
    'utf8',
  );

  const rustCodes = () => {
    const codes = [...refusalSource().matchAll(/render_refusal\(\s*"([A-Za-z]+)"/g)]
      .map((match) => match[1]);
    // A guard whose extraction silently matched nothing would pass forever.
    expect(codes.length).toBeGreaterThanOrEqual(19);
    return [...new Set(codes)];
  };

  test('every code Rust can refuse with survives the transport', () => {
    for (const code of rustCodes()) {
      expect(allowedRenderCode({ code }), `${code} is refused by Rust but unknown here`).toBe(code);
    }
  });

  test('every code Rust can refuse with says something specific to a person', () => {
    const generic = renderFailureMessage('somethingNoOneMints');
    for (const code of rustCodes()) {
      expect(renderFailureMessage(code), `${code} falls back to the generic sentence`)
        .not.toBe(generic);
    }
  });

  test('a code nobody mints is still refused, so the set is an allowlist and not decoration', () => {
    expect(allowedRenderCode({ code: 'renderWhateverYouLike' })).toBe('nativeRenderFailed');
    expect(renderFailureMessage('renderWhateverYouLike'))
      .toBe('The native video render could not be completed');
  });
});
