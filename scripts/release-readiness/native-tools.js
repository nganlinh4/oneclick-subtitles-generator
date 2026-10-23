'use strict';

// yt-dlp, Deno, and FFmpeg/ffprobe: direct reviewed-upstream downloads bound to the upstream audit
// lock, never bundled, with exact notices; FFmpeg stays withheld where no reviewed build exists.

const {
  ENGINE_PLATFORM_BY_TARGET,
  invariant,
  readJson,
} = require('./shared');
const {
  assertCommandWiring,
  assertImmutableSourceUrl,
  assertPositiveInteger,
  assertSafeManifestPath,
  assertSha256,
} = require('./delivery-common');

const NATIVE_TOOL_DELIVERY_PATH =
  'crates/osg-native-tools/delivery/native-tools.delivery.json';
const NATIVE_TOOL_AUDIT_PATH =
  'crates/osg-native-tools/delivery/native-tools.upstreams.lock.json';
const NATIVE_TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
const NATIVE_TOOL_EXPECTATIONS = Object.freeze({
  'yt-dlp': Object.freeze({
    license: 'GPL-3.0-or-later',
    noticeCount: 2,
    repository: 'yt-dlp/yt-dlp',
    releaseTag: '2026.07.04',
    revisionKey: 'ytDlp',
    role: 'yt-dlp',
    version: '2026.07.04',
  }),
  deno: Object.freeze({
    license: 'MIT',
    noticeCount: 1,
    repository: 'denoland/deno',
    releaseTag: 'v2.9.5',
    revisionKey: 'deno',
    role: 'deno',
    version: '2.9.5',
  }),
});

function assertNativeToolNotice(notice, tool, index) {
  const label = `Native tool ${tool.id}.notices[${index}]`;
  invariant(notice && typeof notice === 'object' && !Array.isArray(notice),
    `${label} must be an object`);
  const installPath = assertSafeManifestPath(notice.installPath, `${label}.installPath`);
  invariant(installPath.startsWith('licenses/'), `${label} must install below licenses/`);
  assertImmutableSourceUrl(notice.sourceUrl, label);
  const source = new URL(notice.sourceUrl);
  invariant(source.hostname === 'raw.githubusercontent.com',
    `${label}.sourceUrl must use raw.githubusercontent.com`);
  invariant(source.pathname.includes(`/${tool.sourceRevision}/`),
    `${label}.sourceUrl must bind the reviewed source revision`);
  assertPositiveInteger(notice.sizeBytes, `${label}.sizeBytes`);
  assertSha256(notice.sha256, `${label}.sha256`);
}

function expectedNativeToolExecutable(toolId, target) {
  const suffix = target.endsWith('windows-msvc') ? '.exe' : '';
  return `bin/${toolId}${suffix}`;
}

function assertNativeToolRelease(release, tool, target, expectation) {
  const label = `Native tool ${tool.id} ${target}`;
  invariant(release && typeof release === 'object' && !Array.isArray(release),
    `${label} release must be an object`);
  invariant(release.version === expectation.version,
    `${label} must pin version ${expectation.version}`);
  invariant(release.distributionMode === 'direct-reviewed-source-download-only',
    `${label} must remain direct-reviewed-source-download-only`);

  const artifact = release.artifact;
  invariant(artifact && typeof artifact === 'object' && !Array.isArray(artifact),
    `${label}.artifact must be an object`);
  const asset = assertSafeManifestPath(artifact.asset, `${label}.artifact.asset`);
  invariant(!asset.includes('/'), `${label}.artifact.asset must be one file name`);
  invariant(['raw', 'zip'].includes(artifact.format),
    `${label}.artifact.format must be raw or zip`);
  assertImmutableSourceUrl(artifact.sourceUrl, label);
  const source = new URL(artifact.sourceUrl);
  invariant(source.hostname === 'github.com', `${label} must download from github.com`);
  invariant(source.pathname.startsWith(`/${expectation.repository}/releases/download/`),
    `${label} must download from the reviewed upstream repository`);
  invariant(
    source.pathname ===
      `/${expectation.repository}/releases/download/${expectation.releaseTag}/${encodeURIComponent(asset)}`,
    `${label} must download the exact reviewed release tag ${expectation.releaseTag}`,
  );
  invariant(decodeURIComponent(source.pathname.split('/').at(-1)) === asset,
    `${label}.artifact.asset must match its source URL`);
  assertPositiveInteger(artifact.sizeBytes, `${label}.artifact.sizeBytes`);
  assertSha256(artifact.sha256, `${label}.artifact.sha256`);

  invariant(Array.isArray(release.files) && release.files.length === 1,
    `${label} must inventory exactly one executable`);
  const [file] = release.files;
  const sourcePath = assertSafeManifestPath(file && file.sourcePath, `${label}.files[0].sourcePath`);
  const installPath = assertSafeManifestPath(file && file.installPath, `${label}.files[0].installPath`);
  invariant(file.role === expectation.role, `${label}.files[0].role is invalid`);
  invariant(installPath === expectedNativeToolExecutable(tool.id, target),
    `${label} executable install path is not the managed runtime path`);
  assertPositiveInteger(file.sizeBytes, `${label}.files[0].sizeBytes`);
  assertSha256(file.sha256, `${label}.files[0].sha256`);
  if (artifact.format === 'raw') {
    invariant(sourcePath === asset, `${label} raw artifact source path must match its asset`);
    invariant(file.sizeBytes === artifact.sizeBytes && file.sha256 === artifact.sha256,
      `${label} raw executable must match its downloaded artifact`);
  }
}

function assertNativeToolDelivery(rootDirectory, mappings = []) {
  const delivery = readJson(rootDirectory, NATIVE_TOOL_DELIVERY_PATH);
  const audit = readJson(rootDirectory, NATIVE_TOOL_AUDIT_PATH);
  invariant(delivery.schemaVersion === 1, 'Native-tool delivery must use schemaVersion 1');
  invariant(audit.schemaVersion === 1, 'Native-tool upstream audit must use schemaVersion 1');
  invariant(delivery.policy && delivery.policy.artifactDelivery === 'direct-reviewed-source-download-only',
    'Native-tool delivery must remain direct-reviewed-source-download-only');
  invariant(delivery.policy.bundledArtifacts === false,
    'Native-tool executables must not be bundled in the application');
  invariant(delivery.policy.selfUpdateAllowed === false,
    'Managed native tools must not self-update');

  const bundledTools = mappings.filter(({ destination }) =>
    /(?:^|\/)(?:ffmpeg|ffprobe|yt-dlp|deno)(?:\.exe)?$/i.test(destination));
  invariant(bundledTools.length === 0,
    `Native-tool executables must be installed from the reviewed catalog, not bundled: ${bundledTools.map(({ destination }) => destination).join(', ')}`);

  invariant(Array.isArray(delivery.tools), 'Native-tool delivery must contain tools');
  const ids = delivery.tools.map((tool) => tool && tool.id);
  invariant(new Set(ids).size === ids.length, 'Native-tool delivery IDs must be unique');
  invariant(ids.length === NATIVE_TOOL_IDS.length
    && NATIVE_TOOL_IDS.every((id) => ids.includes(id)),
  `Native-tool delivery must contain exactly: ${NATIVE_TOOL_IDS.join(', ')}`);

  const mediaTools = delivery.tools.find(({ id }) => id === 'media-tools');
  invariant(mediaTools.license === 'GPL-3.0-or-later',
    'Media-tool delivery must declare its GPL license floor');
  invariant(audit.ffmpeg && audit.ffmpeg.requiredEncoder === 'libx264'
    && audit.ffmpeg.deliveryPolicy === 'external-site-first'
    && Array.isArray(audit.ffmpeg.deliveryEnabledPlatforms)
    && audit.ffmpeg.deliveryEnabledPlatforms.length === 1
    && audit.ffmpeg.deliveryEnabledPlatforms[0] === 'windows-x86_64',
  'Native-tool audit must enable only the reviewed Windows FFmpeg direct download');
  invariant(audit.ffmpeg.ffprobeOnly && audit.ffmpeg.ffprobeOnly.deliveryEnabled === false,
    'Native-tool audit must not disguise the reviewed GPL ffprobe builds as LGPL delivery');
  invariant(Array.isArray(audit.ffmpeg.reviewedCandidates)
    && audit.ffmpeg.reviewedCandidates.length > 0
    && audit.ffmpeg.reviewedCandidates.every((candidate) =>
      candidate && candidate.status !== 'approved'
      && Object.values(candidate.platforms || {}).every((platform) =>
        platform.approvedForRedistribution === false)),
  'Every rejected FFmpeg candidate must remain explicitly unapproved');

  for (const target of Object.keys(ENGINE_PLATFORM_BY_TARGET)) {
    const platform = mediaTools.platforms && mediaTools.platforms[ENGINE_PLATFORM_BY_TARGET[target]];
    invariant(platform && Array.isArray(platform.releases),
      `Media-tool delivery is missing ${target}`);
    if (target === 'x86_64-pc-windows-msvc') {
      const approved = audit.ffmpeg.approvedDirectDownloads?.['windows-x86_64'];
      invariant(platform.blocker === null && platform.releases.length === 1,
        'Windows media-tool delivery must contain exactly one reviewed release');
      const release = platform.releases[0];
      invariant(approved && release.version === approved.version
        && release.artifact?.sourceUrl === approved.sourceUrl
        && release.artifact?.sizeBytes === approved.sizeBytes
        && release.artifact?.sha256 === approved.sha256
        && approved.sha256 === approved.publishedSha256
        && approved.sourceRevision === mediaTools.sourceRevision
        && approved.license === mediaTools.license
        && approved.libx264 === true && approved.nonfree === false,
      'Windows media-tool release differs from its upstream audit lock');
      invariant(release.distributionMode === 'direct-reviewed-source-download-only'
        && release.artifact.selectiveExtraction === true
        && release.files.length === 4
        && new Set(release.files.map(({ role }) => role).filter(Boolean)).size === 2,
      'Windows media-tool release must selectively install two executables and two notices');
    } else {
      invariant(platform.releases.length === 0,
        `Media-tool delivery for ${target} must remain disabled until its audit is replaced`);
      invariant(typeof platform.blocker === 'string' && platform.blocker.length >= 40,
        `Media-tool delivery for ${target} needs an exact blocker`);
    }
  }

  for (const toolId of ['yt-dlp', 'deno']) {
    const tool = delivery.tools.find(({ id }) => id === toolId);
    const expectation = NATIVE_TOOL_EXPECTATIONS[toolId];
    const audited = audit[expectation.revisionKey];
    invariant(tool.license === expectation.license,
      `Native tool ${toolId} has an unexpected license`);
    invariant(typeof tool.sourceRevision === 'string' && /^[0-9a-f]{40}$/.test(tool.sourceRevision),
      `Native tool ${toolId} must bind one source revision`);
    invariant(audited && audited.version === expectation.version
      && audited.revision === tool.sourceRevision
      && audited.releaseImmutable === true
      && audited.deliveryPolicy === 'direct-upstream-download-only',
    `Native tool ${toolId} differs from its upstream audit lock`);
    invariant(Array.isArray(tool.notices) && tool.notices.length === expectation.noticeCount,
      `Native tool ${toolId} has an incomplete notice inventory`);
    tool.notices.forEach((notice, index) => assertNativeToolNotice(notice, tool, index));
    const noticeHashes = new Set(tool.notices.map(({ sha256 }) => sha256));
    if (toolId === 'yt-dlp') {
      invariant(noticeHashes.has(audited.licenseSha256)
        && noticeHashes.has(audited.thirdPartyNoticesSha256),
      'yt-dlp notice hashes differ from the upstream audit lock');
    } else {
      invariant(noticeHashes.has(audited.licenseSha256),
        'Deno license hash differs from the upstream audit lock');
    }

    const platforms = tool.platforms;
    invariant(platforms && Object.keys(platforms).length === Object.keys(ENGINE_PLATFORM_BY_TARGET).length,
      `Native tool ${toolId} must cover exactly four target families`);
    for (const target of Object.keys(ENGINE_PLATFORM_BY_TARGET)) {
      const platform = platforms[ENGINE_PLATFORM_BY_TARGET[target]];
      invariant(platform && platform.blocker === null && Array.isArray(platform.releases)
        && platform.releases.length === 1,
      `Native tool ${toolId} must have one reviewed release for ${target}`);
      assertNativeToolRelease(platform.releases[0], tool, target, expectation);
    }
  }

  invariant(Array.isArray(audit.repositoryReleaseBlockers)
    && new Set(audit.repositoryReleaseBlockers).size === audit.repositoryReleaseBlockers.length
    && audit.repositoryReleaseBlockers.every((blocker) =>
      typeof blocker === 'string' && blocker.length >= 40),
  'Native-tool audit must list each repository release blocker exactly once');
  for (const command of [
    'native_tools_catalog',
    'native_tools_status',
    'native_tool_install',
    'native_tool_cancel',
  ]) {
    assertCommandWiring(rootDirectory, command);
  }
  return { audit, delivery, mediaTools };
}

function assertRequiredMediaToolDelivery(rootDirectory, target) {
  const delivery = readJson(rootDirectory, NATIVE_TOOL_DELIVERY_PATH);
  const mediaTools = delivery.tools && delivery.tools.find(({ id }) => id === 'media-tools');
  const platformKey = ENGINE_PLATFORM_BY_TARGET[target];
  invariant(platformKey, `Unsupported native-tool target ${JSON.stringify(target)}`);
  const platform = mediaTools && mediaTools.platforms && mediaTools.platforms[platformKey];
  invariant(platform && Array.isArray(platform.releases) && platform.releases.length > 0,
    `FFmpeg/ffprobe delivery is unavailable for ${target}: ${platform && platform.blocker
      ? platform.blocker
      : 'no reviewed media-tool release exists'}`);
}

module.exports = {
  NATIVE_TOOL_AUDIT_PATH,
  assertNativeToolDelivery,
  assertRequiredMediaToolDelivery,
};
