import { Buffer } from 'node:buffer';

export const FRONTEND_ENTRY_CHUNK_MAX_BYTES = 1_550_000;
export const FRONTEND_INITIAL_JS_MAX_BYTES = 2_750_000;
export const FRONTEND_INITIAL_CHUNK_MAX_COUNT = 18;
export const FRONTEND_CHUNK_WARNING_LIMIT_KB = FRONTEND_ENTRY_CHUNK_MAX_BYTES / 1_000;

export const INTENTIONAL_ASYNC_BOUNDARIES = Object.freeze({
  'node_modules/jszip/dist/jszip.min.js': Object.freeze({
    'src/components/translation/utils/downloadUtils.js': 1,
  }),
  'src/services/alignedNarrationService.js': Object.freeze({
    'src/components/VideoRenderingSection/useNarration.js': 3,
    'src/components/previews/narrationRefreshHandler.js': 1,
  }),
  'src/services/engines/GeminiAdapter.js': Object.freeze({
    'src/hooks/useSubtitles.js': 3,
    'src/hooks/useSubtitlesRetryGeneration.js': 1,
    'src/hooks/useSubtitlesSegmentRetry.js': 1,
  }),
  'src/services/geminiService.js': Object.freeze({
    'src/utils/videoProcessing/analysisUtils.js': 1,
  }),
  'src/services/subtitleCache.js': Object.freeze({
    'src/components/app/ModalHandlers.js': 1,
    'src/components/app/handlers/downloadHandlers.js': 2,
  }),
  'src/utils/cacheUtils.js': Object.freeze({
    'src/components/app/handlers/downloadHandlers.js': 2,
  }),
  'src/utils/qualityScanner.js': Object.freeze({
    'src/components/VideoQualityModal.js': 1,
  }),
  'src/utils/subtitle/subtitleMerger.js': Object.freeze({
    'src/hooks/useSubtitlesSegmentRetry.js': 1,
  }),
  'src/utils/transcriptionRulesStore.js': Object.freeze({
    'src/components/ParallelProcessingStatus.js': 1,
    'src/hooks/useTranslationState.js': 1,
  }),
  'src/utils/userSubtitlesStore.js': Object.freeze({
    'src/hooks/useTranslationState.js': 1,
  }),
  'src/utils/videoProcessing/index.js': Object.freeze({
    'src/hooks/useSubtitles.js': 1,
    'src/hooks/useSubtitlesRetryGeneration.js': 1,
  }),
});

const normalizedPath = (value) => String(value ?? '').replaceAll('\\', '/');
const intentionalTargets = Object.keys(INTENTIONAL_ASYNC_BOUNDARIES);

export const isIntentionalAsyncBoundaryWarning = (log) => (
  log?.code === 'INEFFECTIVE_DYNAMIC_IMPORT'
  && intentionalTargets.some((target) => normalizedPath(log.id).endsWith(`/${target}`))
);

export const handleFrontendBuildLog = (level, log, handler) => {
  if (log?.code === 'INEFFECTIVE_DYNAMIC_IMPORT') {
    if (isIntentionalAsyncBoundaryWarning(log)) return;
    throw new Error(
      `Unexpected ineffective dynamic import outside the reviewed async boundaries: ${normalizedPath(log.id)}`
    );
  }
  handler(level, log);
};

export const createFrontendCodeSplitting = () => ({
  groups: [
    {
      name: 'react',
      test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
      priority: 40,
    },
    {
      name: 'remotion',
      test: /node_modules[\\/](?:@remotion|remotion)[\\/]/,
      priority: 30,
    },
    {
      name: 'vendor',
      test: /node_modules[\\/]/,
      priority: 20,
    },
  ],
});

const fail = (message) => {
  throw new Error(`Frontend bundle boundary failed: ${message}`);
};

export const auditFrontendBundle = (bundle) => {
  const chunks = Object.values(bundle).filter((item) => item?.type === 'chunk');
  const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entries = chunks.filter((chunk) => chunk.isEntry);
  if (entries.length !== 1) fail(`expected one JavaScript entry, found ${entries.length}`);

  const entry = entries[0];
  const initial = new Map();
  const pending = [entry.fileName];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (initial.has(fileName)) continue;
    const chunk = chunksByFileName.get(fileName);
    if (!chunk) fail(`entry graph references missing chunk ${fileName}`);
    initial.set(fileName, chunk);
    pending.push(...chunk.imports);
  }

  const requiredGroups = ['react', 'remotion', 'vendor'];
  for (const name of requiredGroups) {
    const chunk = chunks.find((candidate) => candidate.name === name);
    if (!chunk) fail(`required ${name} chunk is missing`);
    if (!initial.has(chunk.fileName)) fail(`${name} chunk is not in the initial entry graph`);
  }

  const entryBytes = Buffer.byteLength(entry.code, 'utf8');
  const initialBytes = [...initial.values()]
    .reduce((total, chunk) => total + Buffer.byteLength(chunk.code, 'utf8'), 0);
  const initialChunkCount = initial.size;

  if (entryBytes > FRONTEND_ENTRY_CHUNK_MAX_BYTES) {
    fail(`entry is ${entryBytes} bytes; budget is ${FRONTEND_ENTRY_CHUNK_MAX_BYTES}`);
  }
  if (initialBytes > FRONTEND_INITIAL_JS_MAX_BYTES) {
    fail(`initial JavaScript is ${initialBytes} bytes; budget is ${FRONTEND_INITIAL_JS_MAX_BYTES}`);
  }
  if (initialChunkCount > FRONTEND_INITIAL_CHUNK_MAX_COUNT) {
    fail(`initial graph has ${initialChunkCount} chunks; budget is ${FRONTEND_INITIAL_CHUNK_MAX_COUNT}`);
  }

  return Object.freeze({ entryBytes, initialBytes, initialChunkCount });
};

export const createFrontendBundleBoundaryPlugin = () => ({
  name: 'osg-frontend-bundle-boundary',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    auditFrontendBundle(bundle);
  },
});
