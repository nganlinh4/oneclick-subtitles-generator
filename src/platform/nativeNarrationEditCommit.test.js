import {
  claimNativeNarrationEditCommit,
  commitNativeNarrationEdit,
  commitNativeNarrationEdits,
  NATIVE_NARRATION_EDIT_COMMIT_EVENT,
} from './nativeNarrationEditCommit';

const ORIGINAL_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const EDITED_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const original = {
  nativeArtifactId: ORIGINAL_ID,
  filename: `osg-speech-artifact:${ORIGINAL_ID}`,
};
const replacement = {
  ...original,
  nativeArtifactId: EDITED_ID,
  filename: `osg-speech-artifact:${EDITED_ID}`,
};

test('refuses an edit when no mounted project owner can commit it', async () => {
  await expect(commitNativeNarrationEdit(original, replacement)).rejects.toMatchObject({
    code: 'narrationEditOwnerUnavailable',
  });
});

test('awaits the one project owner that claims the opaque commit request', async () => {
  let finishCommit;
  const durableCommit = new Promise((resolve) => { finishCommit = resolve; });
  const owner = vi.fn(() => durableCommit);
  const secondOwner = vi.fn();
  const handleCommit = (event) => {
    expect(claimNativeNarrationEditCommit(event.detail, owner)).toBe(true);
    expect(claimNativeNarrationEditCommit(event.detail, secondOwner)).toBe(false);
  };
  window.addEventListener(NATIVE_NARRATION_EDIT_COMMIT_EVENT, handleCommit);

  let settled = false;
  const commit = commitNativeNarrationEdit(original, replacement)
    .finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(owner).toHaveBeenCalledWith([{
    previousArtifactId: ORIGINAL_ID,
    replacement,
  }]);
  expect(secondOwner).not.toHaveBeenCalled();

  finishCommit([replacement]);
  await expect(commit).resolves.toBe(replacement);
  window.removeEventListener(NATIVE_NARRATION_EDIT_COMMIT_EVENT, handleCommit);
});

test('refuses duplicate targets before a batch can reach the project owner', async () => {
  const owner = vi.fn();
  window.addEventListener(NATIVE_NARRATION_EDIT_COMMIT_EVENT, owner);

  await expect(commitNativeNarrationEdits([
    { previous: original, replacement },
    { previous: original, replacement: { ...replacement } },
  ])).rejects.toMatchObject({ code: 'invalidNarrationEditCommit' });
  expect(owner).not.toHaveBeenCalled();

  window.removeEventListener(NATIVE_NARRATION_EDIT_COMMIT_EVENT, owner);
});
