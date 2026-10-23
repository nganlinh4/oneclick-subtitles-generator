'use strict';

// The root licence and THIRD_PARTY_NOTICES.md must exist, recorded release blockers must be empty,
// and any bundled PromptDJ font needs its own notice.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, invariant, toRepositoryPath, walkFiles } = require('./shared');
const { NATIVE_TOOL_AUDIT_PATH } = require('./native-tools');

const PROMPTDJ_FONT_DIRECTORY = 'promptdj-midi/assets/fonts';
const DISTRIBUTABLE_FONT_EXTENSION = /\.(?:eot|otf|ttf|woff2?)$/i;

function collectPromptDjFontReleasePolicyFailures(rootDirectory) {
  const fontRoot = path.join(rootDirectory, PROMPTDJ_FONT_DIRECTORY);
  const fontFiles = walkFiles(fontRoot, (candidate) => DISTRIBUTABLE_FONT_EXTENSION.test(candidate))
    .map((absolutePath) => toRepositoryPath(rootDirectory, absolutePath))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (fontFiles.length === 0) {
    return [];
  }

  const failures = [];
  const noticesPath = path.join(rootDirectory, 'THIRD_PARTY_NOTICES.md');
  const notices = fs.existsSync(noticesPath)
    ? fs.readFileSync(noticesPath, 'utf8')
    : '';
  const missingNotices = fontFiles.filter((relativePath) => {
    const fileName = path.posix.basename(relativePath);
    return !notices.includes(relativePath) && !notices.includes(fileName);
  });
  if (missingNotices.length > 0) {
    failures.push(
      `Bundled PromptDJ font assets are absent from THIRD_PARTY_NOTICES.md: ${missingNotices.join(', ')}`,
    );
  }
  return failures;
}

function assertRepositoryReleasePolicy(rootDirectory) {
  const audit = readJson(rootDirectory, NATIVE_TOOL_AUDIT_PATH);
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
    .map((name) => path.join(rootDirectory, name))
    .find((candidate) => fs.existsSync(candidate));
  const notices = path.join(rootDirectory, 'THIRD_PARTY_NOTICES.md');
  const failures = new Set(Array.isArray(audit.repositoryReleaseBlockers)
    ? audit.repositoryReleaseBlockers
    : []);
  if (!license && ![...failures].some((failure) => /root LICENSE/i.test(failure))) {
    failures.add('The repository owner has not selected a root LICENSE.');
  }
  if (!fs.existsSync(notices)
      && ![...failures].some((failure) => /third-party notices/i.test(failure))) {
    failures.add('THIRD_PARTY_NOTICES.md is missing.');
  }
  for (const failure of collectPromptDjFontReleasePolicyFailures(rootDirectory)) {
    failures.add(failure);
  }
  invariant(failures.size === 0,
    `Repository licensing/notice policy is unresolved: ${[...failures].join('; ')}`);
}

module.exports = {
  assertRepositoryReleasePolicy,
  collectPromptDjFontReleasePolicyFailures,
};
