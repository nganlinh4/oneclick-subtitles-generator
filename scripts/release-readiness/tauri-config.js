'use strict';

// Tauri bundle configuration: packaged resources and workers, production CSP, and the production
// build route that embeds the frontend instead of retaining the development URL.

const fs = require('node:fs');
const path = require('node:path');

const {
  REPOSITORY_ROOT,
  TARGETS,
  TAURI_CONFIG_PATH,
  TAURI_DIRECTORY,
  extractTomlSection,
  invariant,
  readJson,
  readText,
  toRepositoryPath,
  walkFiles,
} = require('./shared');

function normalizeDestination(destination) {
  invariant(typeof destination === 'string' && destination.length > 0, 'Resource destinations must be non-empty strings');
  const normalized = destination.replaceAll('\\', '/').replace(/^\.\//, '');
  invariant(!path.posix.isAbsolute(normalized), `Resource destination must be relative: ${destination}`);
  const components = normalized.split('/');
  invariant(
    components.every((component) => component && component !== '.' && component !== '..'),
    `Resource destination may not escape or contain empty components: ${destination}`,
  );
  return normalized;
}

function platformConfigName(target) {
  if (!target) {
    return undefined;
  }
  const entry = TARGETS[target];
  invariant(entry, `Unsupported release target ${JSON.stringify(target)}`);
  if (target.endsWith('windows-msvc')) {
    return 'tauri.windows.conf.json';
  }
  if (target.endsWith('apple-darwin')) {
    return 'tauri.macos.conf.json';
  }
  return 'tauri.linux.conf.json';
}

function collectResourceMappings(rootDirectory = REPOSITORY_ROOT, target) {
  const configDirectory = path.join(rootDirectory, TAURI_DIRECTORY);
  const baseConfig = readJson(rootDirectory, TAURI_CONFIG_PATH);
  const resourceObjects = [baseConfig.bundle && baseConfig.bundle.resources];
  const platformConfig = platformConfigName(target);
  if (platformConfig && fs.existsSync(path.join(configDirectory, platformConfig))) {
    const config = readJson(rootDirectory, `${TAURI_DIRECTORY}/${platformConfig}`);
    resourceObjects.push(config.bundle && config.bundle.resources);
  }

  const byDestination = new Map();
  for (const resources of resourceObjects) {
    if (resources === undefined) {
      continue;
    }
    invariant(
      resources && typeof resources === 'object' && !Array.isArray(resources),
      'Tauri bundle.resources must be an object mapping source files to stable destinations',
    );
    for (const [source, rawDestination] of Object.entries(resources)) {
      const destination = normalizeDestination(rawDestination);
      invariant(!byDestination.has(destination), `Duplicate Tauri resource destination: ${destination}`);
      const sourceAbsolute = path.resolve(configDirectory, source);
      const relativeSource = path.relative(rootDirectory, sourceAbsolute);
      invariant(
        relativeSource && !relativeSource.startsWith('..') && !path.isAbsolute(relativeSource),
        `Tauri resource source must stay inside the repository: ${source}`,
      );
      invariant(fs.existsSync(sourceAbsolute), `Tauri resource source does not exist: ${source}`);
      const sourceMetadata = fs.lstatSync(sourceAbsolute);
      invariant(!sourceMetadata.isSymbolicLink(), `Tauri resource source may not be a symlink: ${source}`);
      invariant(sourceMetadata.isFile(), `Tauri resource source must be a file: ${source}`);
      invariant(sourceMetadata.size > 0, `Tauri resource source is empty: ${source}`);
      byDestination.set(destination, {
        destination,
        source,
        sourceAbsolute,
        size: sourceMetadata.size,
      });
    }
  }
  return [...byDestination.values()];
}

function collectEmbeddedWorkers(rootDirectory = REPOSITORY_ROOT) {
  const sourceDirectory = path.join(rootDirectory, TAURI_DIRECTORY, 'src');
  const rustSources = walkFiles(sourceDirectory, (candidate) => candidate.endsWith('.rs'));
  const workers = [];
  for (const rustSource of rustSources) {
    const source = fs.readFileSync(rustSource, 'utf8');
    for (const match of source.matchAll(/include_bytes!\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!/_worker\.(?:py|mjs)$/i.test(match[1])) {
        continue;
      }
      const workerPath = path.resolve(path.dirname(rustSource), match[1]);
      invariant(fs.existsSync(workerPath), `Embedded worker source does not exist: ${match[1]}`);
      workers.push({
        name: path.basename(workerPath),
        sourceAbsolute: workerPath,
        rustSource: toRepositoryPath(rootDirectory, rustSource),
      });
    }
  }
  return workers;
}

function assertWorkerResources(rootDirectory = REPOSITORY_ROOT, mappings = collectResourceMappings(rootDirectory)) {
  const attributesPath = path.join(rootDirectory, '.gitattributes');
  invariant(fs.existsSync(attributesPath), 'Packaged worker checkout rules require .gitattributes');
  const attributes = fs.readFileSync(attributesPath, 'utf8');
  for (const rule of ['*.mjs text eol=lf', '*.py text eol=lf']) {
    invariant(
      attributes.split(/\r?\n/).includes(rule),
      `Packaged worker checkout rules must include ${rule}`,
    );
  }
  const workers = collectEmbeddedWorkers(rootDirectory);
  const expectedWorkers = new Set(['osg_asr_worker.py', 'osg_speech_worker.py']);
  const discoveredWorkers = new Set(workers.map((worker) => worker.name));
  for (const expectedWorker of expectedWorkers) {
    invariant(discoveredWorkers.has(expectedWorker), `Desktop bootstrap must embed ${expectedWorker}`);
  }

  for (const worker of workers) {
    const mapping = mappings.find(
      (candidate) => path.resolve(candidate.sourceAbsolute) === path.resolve(worker.sourceAbsolute),
    );
    invariant(
      mapping,
      `${worker.rustSource} embeds ${worker.name}, but Tauri bundle.resources does not package the same file`,
    );
    invariant(
      mapping.destination === `workers/${worker.name}`,
      `${worker.name} must be packaged at workers/${worker.name}, received ${mapping.destination}`,
    );
  }
}

function assertProductionCsp(config) {
  const csp = config && config.app && config.app.security && config.app.security.csp;
  const connectSource = csp && csp['connect-src'];
  invariant(typeof connectSource === 'string', 'Tauri production CSP must declare connect-src as a string');
  const directives = connectSource.trim().split(/\s+/).filter(Boolean);
  invariant(directives.includes("'self'"), "Production connect-src must retain 'self'");
  invariant(directives.includes('ipc:'), 'Production connect-src must retain ipc:');
  const allowed = new Set(["'self'", 'ipc:', 'http://ipc.localhost', 'https://ipc.localhost']);
  const forbidden = directives.filter((directive) => !allowed.has(directive));
  invariant(
    forbidden.length === 0,
    `Production connect-src may contain only self/Tauri IPC endpoints; remove: ${forbidden.join(', ')}`,
  );
  const imageSource = csp && csp['img-src'];
  invariant(typeof imageSource === 'string', 'Tauri production CSP must declare img-src as a string');
  const imageDirectives = imageSource.trim().split(/\s+/).filter(Boolean);
  const allowedImages = new Set(["'self'", 'data:', 'blob:', 'http://127.0.0.1:*']);
  const forbiddenImages = imageDirectives.filter((directive) => !allowedImages.has(directive));
  invariant(
    imageDirectives.includes('http://127.0.0.1:*') && forbiddenImages.length === 0,
    `Production img-src may contain only local assets and tokenized loopback images; remove: ${forbiddenImages.join(', ')}`,
  );
}

function assertTauriConfiguration(rootDirectory = REPOSITORY_ROOT) {
  const config = readJson(rootDirectory, TAURI_CONFIG_PATH);
  invariant(config.bundle && config.bundle.active === true, 'Tauri bundle.active must remain true');
  invariant(config.bundle.targets === 'all', 'Tauri bundle.targets must remain all; CI supplies the host-specific subset');
  invariant(
    config.bundle.useLocalToolsDir === undefined || config.bundle.useLocalToolsDir === false,
    'Tauri bundle.useLocalToolsDir must remain false so verified Windows tools use the reviewed user-cache path',
  );
  invariant(
    typeof config.identifier === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(config.identifier),
    'Tauri identifier must be a stable reverse-domain identifier',
  );
  assertProductionCsp(config);

  invariant(Array.isArray(config.bundle.icon) && config.bundle.icon.length > 0, 'Tauri bundle.icon must list release icons');
  for (const icon of config.bundle.icon) {
    invariant(typeof icon === 'string' && icon.length > 0, 'Tauri bundle icon entries must be paths');
    const iconPath = path.resolve(rootDirectory, TAURI_DIRECTORY, icon);
    invariant(fs.existsSync(iconPath), `Tauri release icon does not exist: ${icon}`);
    const metadata = fs.lstatSync(iconPath);
    invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `Tauri release icon is invalid: ${icon}`);
  }
  const mappings = collectResourceMappings(rootDirectory);
  assertWorkerResources(rootDirectory, mappings);
  return mappings;
}

function assertTauriProductionBuildContract(rootDirectory = REPOSITORY_ROOT) {
  const rootPackage = readJson(rootDirectory, 'package.json');
  const desktopPackage = readJson(rootDirectory, 'apps/desktop/package.json');
  invariant(
    rootPackage.scripts?.['tauri:build']
      === 'node scripts/run-managed-command.js --lane package -- npm --prefix apps/desktop run tauri:build --',
    'Root tauri:build must use the managed package lane and guarded desktop production script',
  );
  invariant(
    rootPackage.scripts?.build === 'npm run tauri:build',
    'Root build must use the guarded Tauri production build script',
  );
  invariant(
    desktopPackage.scripts?.['tauri:build']
      === 'node ../../scripts/run-tauri-cli.js build --features production',
    'Desktop tauri:build must reject unmanaged local builds and enable production protocol',
  );

  const cargoToml = readText(rootDirectory, `${TAURI_DIRECTORY}/Cargo.toml`);
  const features = extractTomlSection(cargoToml, 'features');
  invariant(
    /^\s*default\s*=\s*\[\s*]\s*(?:#.*)?$/m.test(features),
    'Desktop Cargo default features must remain empty so development mode uses the dev URL',
  );
  // Exactly custom-protocol: devtools, the updater-disabled local-test channel, the E2E
  // automation seams, and the CI updater fixture are reachable only from their own features.
  invariant(
    /^\s*production\s*=\s*\[\s*["']tauri\/custom-protocol["']\s*]\s*(?:#.*)?$/m.test(features),
    'Desktop Cargo production feature must enable only tauri/custom-protocol',
  );
  const dependencies = extractTomlSection(cargoToml, 'dependencies');
  invariant(
    /^\s*rfd\s*=\s*\{\s*version\s*=\s*["']=0\.16\.0["']\s*,\s*default-features\s*=\s*false\s*}\s*(?:#.*)?$/m
      .test(dependencies),
    'Desktop Cargo must pin its direct rfd dependency to 0.16.0 without default features',
  );

  // Every packaged channel carries `tauri/custom-protocol`; what must stay refused is a release
  // built with none of them, which keeps the development URL and would point at localhost.
  const mainSource = readText(rootDirectory, `${TAURI_DIRECTORY}/src/main.rs`);
  invariant(
    /#\[cfg\(all\(\s*not\(debug_assertions\),\s*not\(feature\s*=\s*["']production["']\),\s*not\(feature\s*=\s*["']unsigned-local-build["']\),\s*not\(feature\s*=\s*["']e2e-automation["']\)\s*\)\)]\s*compile_error!\s*\(/m
      .test(mainSource),
    'Desktop main.rs must reject release builds that omit every packaged-channel feature',
  );
}

module.exports = {
  assertProductionCsp,
  assertTauriConfiguration,
  assertTauriProductionBuildContract,
  assertWorkerResources,
  collectResourceMappings,
  normalizeDestination,
};
