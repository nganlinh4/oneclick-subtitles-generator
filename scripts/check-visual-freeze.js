#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { VISITOR_KEYS } = require('@babel/types');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'frontend-visual-baseline.json');
const SCHEMA_VERSION = 5;
const ALGORITHM = 'sha256';
const NORMALIZATION =
  'binary exact; UTF-8 BOM ignored, CRLF/CR normalized to LF, terminal newlines ignored';
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss']);
const NORMALIZED_TEXT_EXTENSIONS = new Set([
  '.css',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.scss',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.vtt',
  '.xml',
]);
const GENERATED_FILES = new Set(['src/config/appConfig.js', 'src/config/version.js']);
const EVENT_HANDLER_ATTRIBUTE = /^on[A-Z]/;
const MAX_GIT_BUFFER = 256 * 1024 * 1024;
const RETIRED_EXACT_FILES = Object.freeze({
  'public/oauth2callback.html': 'c19855fd5a3f19af1eea1c1fed6e7794a342136223dd60dbead2586d4298fd90',
});
const NATIVE_PROVIDER_IMAGE_SOURCES = new Set([
  'src/components/inputs/VideoPreviewRenderer.js',
  'src/components/inputs/YoutubeUrlInput.js',
]);
const LEGACY_SELECTED_VIDEO_IMAGE = 'src={`https://img.youtube.com/vi/${selectedVideo.id}/0.jpg`}';
const NATIVE_SELECTED_VIDEO_IMAGE = 'src={selectedVideo.thumbnail}';
const SECURITY_COPY_RENDER_CORRECTIONS = Object.freeze({
  'src/components/settings/tabs/YoutubeAuthSection.js': Object.freeze([
    Object.freeze(['Create OAuth 2.0 Client ID (Web application)', 'Create OAuth 2.0 Client ID (Desktop app)', 1]),
    Object.freeze(['Add Authorized JavaScript origins:', 'Confirm the application type:', 1]),
    Object.freeze(['Add Authorized redirect URI:', 'OSG uses this temporary loopback callback pattern:', 1]),
    Object.freeze([
      "This error occurs when the redirect URI in your application doesn\\'t match what\\'s registered in Google Cloud Console:",
      'This usually means the OAuth client is not configured as a desktop application:',
      1,
    ]),
    Object.freeze(['In "Authorized JavaScript origins", add exactly:', 'The OAuth client application type must be:', 1]),
    Object.freeze(['In "Authorized redirect URIs", add exactly:', 'Retry authentication; OSG will select a new loopback callback:', 1]),
    Object.freeze([
      "<code>{window.location.origin + '/oauth2callback.html'}</code>",
      '<code>{LOOPBACK_CALLBACK_PATTERN}</code>',
      2,
    ]),
    Object.freeze(['<code>{window.location.origin}</code>', '<code>{DESKTOP_OAUTH_CLIENT_TYPE}</code>', 2]),
  ]),
});
const SECURITY_COPY_LOCALE_CORRECTIONS = Object.freeze({
  'src/i18n/locales/en/settings.json': Object.freeze({
    apiKeyDescription: Object.freeze(['Your API key is stored locally in your browser and never sent to our servers.', "Your API key is stored in your operating system's credential store and used only by native provider requests."]),
    createOAuthClientId: Object.freeze(['Create OAuth 2.0 client ID (web application)', 'Create OAuth 2.0 client ID (desktop app)']),
    addAuthorizedOrigins: Object.freeze(['Add authorized JavaScript origins:', 'Confirm the application type:']),
    addAuthorizedRedirect: Object.freeze(['Add authorized redirect URI:', 'OSG uses this temporary loopback callback pattern:']),
    redirectMismatchDescription: Object.freeze(["This error occurs when the redirect URI in your application doesn't match the URI registered in Google Cloud Console:", 'This usually means the OAuth client is not configured as a desktop application:']),
    inAuthorizedOrigins: Object.freeze(["In 'Authorized JavaScript origins', add exactly:", 'The OAuth client application type must be:']),
    inAuthorizedRedirect: Object.freeze(["In 'Authorized redirect URIs', add exactly:", 'Retry authentication; OSG will select a new loopback callback:']),
  }),
  'src/i18n/locales/ko/settings.json': Object.freeze({
    apiKeyDescription: Object.freeze(['API 키는 브라우저에 로컬로 저장되며 절대 우리 서버로 전송되지 않습니다.', 'API 키는 운영 체제의 자격 증명 저장소에 보관되며 네이티브 제공자 요청에만 사용됩니다.']),
    createOAuthClientId: Object.freeze(['OAuth 2.0 클라이언트 ID 생성 (웹 애플리케이션)', 'OAuth 2.0 클라이언트 ID 생성 (데스크톱 앱)']),
    addAuthorizedOrigins: Object.freeze(['승인된 JavaScript 출처 추가:', '애플리케이션 유형 확인:']),
    addAuthorizedRedirect: Object.freeze(['승인된 리디렉션 URI 추가:', 'OSG는 다음 임시 루프백 콜백 형식을 사용합니다:']),
    redirectMismatchDescription: Object.freeze(['이 오류는 애플리케이션의 리디렉션 URI가 Google Cloud Console에 등록된 URI와 일치하지 않을 때 발생합니다:', '이 오류는 일반적으로 OAuth 클라이언트가 데스크톱 애플리케이션으로 설정되지 않았을 때 발생합니다:']),
    inAuthorizedOrigins: Object.freeze(["'승인된 JavaScript 출처'에 정확히 추가:", 'OAuth 클라이언트 애플리케이션 유형:']),
    inAuthorizedRedirect: Object.freeze(["'승인된 리디렉션 URI'에 정확히 추가:", '인증을 다시 시도하면 OSG가 새 루프백 콜백을 선택합니다:']),
  }),
  'src/i18n/locales/vi/settings.json': Object.freeze({
    apiKeyDescription: Object.freeze(['Khóa API được lưu trữ cục bộ trong trình duyệt của bạn và không bao giờ được gửi đến máy chủ của chúng tôi.', 'Khóa API được lưu trong kho thông tin xác thực của hệ điều hành và chỉ được ứng dụng gốc sử dụng cho các yêu cầu đến nhà cung cấp.']),
    createOAuthClientId: Object.freeze(['Tạo ID khách hàng OAuth 2.0 (ứng dụng web)', 'Tạo ID khách hàng OAuth 2.0 (ứng dụng máy tính)']),
    addAuthorizedOrigins: Object.freeze(['Thêm nguồn JavaScript được phép:', 'Xác nhận loại ứng dụng:']),
    addAuthorizedRedirect: Object.freeze(['Thêm URI chuyển hướng được phép:', 'OSG sử dụng mẫu gọi lại vòng lặp tạm thời này:']),
    redirectMismatchDescription: Object.freeze(['Lỗi này xảy ra khi URI chuyển hướng trong ứng dụng của bạn không khớp với URI đã đăng ký trong Google Cloud Console:', 'Lỗi này thường có nghĩa là ứng dụng OAuth chưa được cấu hình là ứng dụng máy tính:']),
    inAuthorizedOrigins: Object.freeze(['Trong "Nguồn JavaScript được phép", thêm chính xác:', 'Loại ứng dụng của ID khách hàng OAuth phải là:']),
    inAuthorizedRedirect: Object.freeze(['Trong "URI chuyển hướng được phép", thêm chính xác:', 'Thử xác thực lại; OSG sẽ chọn một địa chỉ gọi lại vòng lặp mới:']),
  }),
});

function canonicalizeReviewedCorrections(source, corrections, label) {
  let canonical = source;
  for (const [index, [legacy, current, expectedCount = 1]] of corrections.entries()) {
    const legacyCount = canonical.split(legacy).length - 1;
    const currentCount = canonical.split(current).length - 1;
    if (legacyCount === expectedCount && currentCount === 0) canonical = canonical.replaceAll(legacy, current);
    else if (legacyCount !== 0 || currentCount !== expectedCount) {
      throw new Error(
        `reviewed security correction ${index + 1} drifted for ${label}: expected ${expectedCount} legacy or current markers, ` +
          `found ${legacyCount}/${currentCount}`,
      );
    }
  }
  return canonical;
}

function canonicalizeRuntimeRenderSource(relativePath, source) {
  let canonical = source;
  if (NATIVE_PROVIDER_IMAGE_SOURCES.has(relativePath)) {
    const legacyCount = canonical.split(LEGACY_SELECTED_VIDEO_IMAGE).length - 1;
    const nativeCount = canonical.split(NATIVE_SELECTED_VIDEO_IMAGE).length - 1;
    if (legacyCount === 1 && nativeCount === 0) {
      canonical = canonical.replace(LEGACY_SELECTED_VIDEO_IMAGE, NATIVE_SELECTED_VIDEO_IMAGE);
    } else if (legacyCount !== 0 || nativeCount !== 1) {
      throw new Error(
        `native provider-image render contract drifted for ${relativePath}: ` +
          `expected one legacy or native selected-video source, found ${legacyCount}/${nativeCount}`,
      );
    }
  }
  const corrections = SECURITY_COPY_RENDER_CORRECTIONS[relativePath];
  return corrections
    ? canonicalizeReviewedCorrections(canonical, corrections, relativePath)
    : canonical;
}

function canonicalizeLocaleValue(relativePath, value) {
  const corrections = SECURITY_COPY_LOCALE_CORRECTIONS[relativePath];
  if (!corrections) return value;
  for (const [key, [legacy, current]] of Object.entries(corrections)) {
    if (value[key] === legacy) value[key] = current;
    else if (value[key] !== current) {
      throw new Error(`reviewed locale security correction drifted for ${relativePath}:${key}`);
    }
  }
  return value;
}

function assertVisualRuntimePins() {
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8'),
  );
  const renderer = lock.packages?.['video-renderer'];
  const exactPins = [
    [packageManifest.dependencies?.['@material/web'], '2.4.1', 'material-manifest'],
    [lock.packages?.['node_modules/@material/web']?.version, '2.4.1', 'material-lock'],
    [lock.packages?.['node_modules/lit']?.version, '3.3.2', 'lit-lock'],
    [lock.packages?.['node_modules/react']?.version, '18.3.1', 'react-lock'],
    [lock.packages?.['node_modules/react-dom']?.version, '18.3.1', 'react-dom-lock'],
    [renderer?.dependencies?.react, '18.3.1', 'renderer-react'],
    [renderer?.dependencies?.['react-dom'], '18.3.1', 'renderer-react-dom'],
    [renderer?.dependencies?.['styled-components'], '6.5.1', 'renderer-styled-components'],
  ];
  const changed = exactPins.find(([actual, expected]) => actual !== expected);
  if (changed) {
    throw new Error(`visual runtime dependency changed: ${changed[2]}`);
  }
  if (
    lock.packages?.['video-renderer/node_modules/react'] ||
    lock.packages?.['video-renderer/node_modules/react-dom']
  ) {
    throw new Error('visual runtime contains a duplicate renderer React installation');
  }
}

function toRepositoryPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function sha256(value) {
  return crypto.createHash(ALGORITHM).update(value).digest('hex');
}

function normalizeText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

function normalizedContents(relativePath, contents) {
  const extension = path.extname(relativePath).toLowerCase();
  if (!NORMALIZED_TEXT_EXTENSIONS.has(extension)) return contents;
  return Buffer.from(normalizeText(contents.toString('utf8')), 'utf8');
}

function hashContents(relativePath, contents) {
  return sha256(normalizedContents(relativePath, contents));
}

function isExcludedSource(relativePath) {
  const repositoryPath = toRepositoryPath(relativePath);
  if (GENERATED_FILES.has(repositoryPath) || repositoryPath === 'src/setupTests.js') return true;
  if (
    repositoryPath.includes('/test-utils/') ||
    repositoryPath.includes('/__tests__/') ||
    repositoryPath.includes('/__mocks__/')
  ) {
    return true;
  }
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(repositoryPath);
}

function isRenderSource(relativePath) {
  return (
    toRepositoryPath(relativePath).startsWith('src/') &&
    SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) &&
    !isExcludedSource(relativePath)
  );
}

function isExactVisualFile(relativePath) {
  const repositoryPath = toRepositoryPath(relativePath);
  const extension = path.extname(repositoryPath).toLowerCase();
  if (repositoryPath.startsWith('public/')) return true;
  if (STYLE_EXTENSIONS.has(extension) && repositoryPath.startsWith('src/')) return true;
  if (!repositoryPath.startsWith('src/assets/')) return false;
  return true;
}

function isLocaleFile(relativePath) {
  return /^src\/i18n\/locales\/(?:en|ko|vi)\/[^/]+\.json$/.test(
    toRepositoryPath(relativePath),
  );
}

function localeSurface(relativePath, contents) {
  let value;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(`cannot parse locale source ${relativePath}: ${error.message}`);
  }
  value = canonicalizeLocaleValue(toRepositoryPath(relativePath), value);
  const leafHashes = {};
  function visit(current, prefix) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of Object.keys(current).sort((left, right) => left.localeCompare(right, 'en'))) {
        visit(current[key], prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    if (!prefix) throw new Error(`locale source has no keyed values: ${relativePath}`);
    leafHashes[prefix] = sha256(JSON.stringify(current));
  }
  visit(value, '');
  const keys = Object.keys(leafHashes).sort((left, right) => left.localeCompare(right, 'en'));
  const surface = {
    hash: sha256(JSON.stringify(keys.map((key) => [key, leafHashes[key]]))),
    keys,
  };
  Object.defineProperty(surface, '_leafHashes', {value: leafHashes});
  return surface;
}

function listWorkingTreeFiles(rootDirectory = REPOSITORY_ROOT) {
  const files = [];
  for (const root of ['public', 'src']) {
    const absoluteRoot = path.join(rootDirectory, root);
    if (!fs.existsSync(absoluteRoot)) throw new Error(`visual root is missing: ${root}`);
    visitDirectory(absoluteRoot, rootDirectory, files);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function visitDirectory(absoluteDirectory, rootDirectory, files) {
  const entries = fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = toRepositoryPath(path.relative(rootDirectory, absolutePath));
    if (entry.isSymbolicLink()) {
      throw new Error(`visual roots may not contain symbolic links: ${relativePath}`);
    }
    if (entry.isDirectory()) visitDirectory(absolutePath, rootDirectory, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

function createWorkingTreeProvider(rootDirectory = REPOSITORY_ROOT) {
  return {
    listFiles: () => listWorkingTreeFiles(rootDirectory),
    readFile: (relativePath) => fs.readFileSync(path.join(rootDirectory, relativePath)),
  };
}

function runGit(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPOSITORY_ROOT,
      encoding: options.encoding,
      maxBuffer: MAX_GIT_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString('utf8').trim() : error.message;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

function resolveCommit(reference) {
  const revision = runGit(['rev-parse', '--verify', `${reference}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`invalid baseline commit: ${reference}`);
  return revision;
}

function createGitProvider(reference) {
  const revision = resolveCommit(reference);
  const output = runGit(['ls-tree', '-r', '-z', '--name-only', revision, '--', 'public', 'src']);
  const files = output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return {
    revision,
    listFiles: () => files,
    readFile: (relativePath) => runGit(['show', `${revision}:${relativePath}`]),
  };
}

function parseRenderSource(source, relativePath = 'source.jsx') {
  const extension = path.extname(relativePath).toLowerCase();
  const plugins = [
    'jsx',
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'dynamicImport',
    'importMeta',
    'topLevelAwait',
  ];
  if (extension === '.ts' || extension === '.tsx') plugins.push('typescript');
  try {
    return parse(source, {
      sourceType: 'unambiguous',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins,
    });
  } catch (error) {
    const location = error.loc ? `${error.loc.line}:${error.loc.column}` : 'unknown';
    throw new Error(`cannot parse visual source ${relativePath} at ${location}: ${error.message}`);
  }
}

function cleanJsxText(value) {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  let lastNonEmptyLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/[^\t ]/.test(lines[index])) lastNonEmptyLine = index;
  }
  let result = '';
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\t/g, ' ');
    if (index !== 0) line = line.replace(/^ +/, '');
    if (index !== lines.length - 1) line = line.replace(/ +$/, '');
    if (line && index !== lastNonEmptyLine) line += ' ';
    result += line;
  }
  return result;
}

function jsxName(node) {
  if (!node) return '?';
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXNamespacedName') return `${jsxName(node.namespace)}:${jsxName(node.name)}`;
  if (node.type === 'JSXMemberExpression') return `${jsxName(node.object)}.${jsxName(node.property)}`;
  return node.type;
}

function literalValue(node) {
  if (node.type === 'StringLiteral') return ['string', node.value];
  if (node.type === 'NumericLiteral') return ['number', String(node.value)];
  if (node.type === 'BooleanLiteral') return ['boolean', node.value];
  if (node.type === 'NullLiteral') return ['null'];
  if (node.type === 'BigIntLiteral' || node.type === 'DecimalLiteral') {
    return [node.type, String(node.value)];
  }
  if (node.type === 'RegExpLiteral') return ['regexp', node.pattern, node.flags];
  return null;
}

class ExpressionFingerprinter {
  constructor() {
    this.identifiers = new Map();
  }

  identifier(name) {
    if (!this.identifiers.has(name)) this.identifiers.set(name, `$${this.identifiers.size}`);
    return this.identifiers.get(name);
  }

  pattern(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return ['binding', this.identifier(node.name)];
    if (node.type === 'RestElement') return ['rest', this.pattern(node.argument)];
    if (node.type === 'AssignmentPattern') {
      return ['assignment-pattern', this.pattern(node.left), this.expression(node.right)];
    }
    if (node.type === 'ArrayPattern') return ['array-pattern', node.elements.map((item) => this.pattern(item))];
    if (node.type === 'ObjectPattern') {
      return [
        'object-pattern',
        node.properties.map((property) => {
          if (property.type === 'RestElement') return this.pattern(property);
          return [
            'property',
            this.propertyKey(property.key, property.computed),
            this.pattern(property.value),
          ];
        }),
      ];
    }
    return this.expression(node);
  }

  propertyKey(node, computed) {
    if (computed) return ['computed', this.expression(node)];
    if (node.type === 'Identifier' || node.type === 'PrivateName') return ['name', node.name || node.id.name];
    return ['key', this.expression(node)];
  }

  memberProperty(node, computed) {
    if (!computed && (node.type === 'Identifier' || node.type === 'PrivateName')) {
      return ['name', node.name || node.id.name];
    }
    return this.expression(node);
  }

  expression(node) {
    if (!node) return null;
    const literal = literalValue(node);
    if (literal) return literal;
    switch (node.type) {
      case 'Identifier':
        return ['identifier', this.identifier(node.name)];
      case 'ThisExpression':
      case 'Super':
        return [node.type];
      case 'JSXElement':
        return this.jsxElement(node);
      case 'JSXFragment':
        return this.jsxFragment(node);
      case 'JSXText':
        return ['text', cleanJsxText(node.value)];
      case 'JSXExpressionContainer':
        return this.expression(node.expression);
      case 'JSXEmptyExpression':
        return ['empty'];
      case 'TemplateLiteral':
        return [
          'template',
          node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw),
          node.expressions.map((expression) => this.expression(expression)),
        ];
      case 'TaggedTemplateExpression':
        return ['tagged-template', this.expression(node.tag), this.expression(node.quasi)];
      case 'ConditionalExpression':
        return [
          'conditional',
          this.expression(node.test),
          this.expression(node.consequent),
          this.expression(node.alternate),
        ];
      case 'LogicalExpression':
      case 'BinaryExpression':
        return [node.type, node.operator, this.expression(node.left), this.expression(node.right)];
      case 'UnaryExpression':
      case 'UpdateExpression':
        return [node.type, node.operator, node.prefix, this.expression(node.argument)];
      case 'AssignmentExpression':
        return [
          'assignment',
          node.operator,
          this.expression(node.left),
          this.expression(node.right),
        ];
      case 'SequenceExpression':
        return ['sequence', node.expressions.map((expression) => this.expression(expression))];
      case 'AwaitExpression':
      case 'YieldExpression':
        return [node.type, Boolean(node.delegate), this.expression(node.argument)];
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        return [
          node.type,
          Boolean(node.optional),
          this.expression(node.object),
          this.memberProperty(node.property, node.computed),
        ];
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression':
        return [
          node.type,
          Boolean(node.optional),
          this.expression(node.callee),
          node.arguments.map((argument) =>
            argument.type === 'SpreadElement'
              ? ['spread', this.expression(argument.argument)]
              : this.expression(argument),
          ),
        ];
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return [
          node.type,
          Boolean(node.async),
          Boolean(node.generator),
          node.params.map((parameter) => this.pattern(parameter)),
          this.expression(node.body),
        ];
      case 'ObjectExpression':
        return [
          'object',
          node.properties.map((property) => {
            if (property.type === 'SpreadElement') return ['spread', this.expression(property.argument)];
            if (property.type === 'ObjectMethod') {
              return [
                'method',
                property.kind,
                this.propertyKey(property.key, property.computed),
                property.params.map((parameter) => this.pattern(parameter)),
                this.expression(property.body),
              ];
            }
            return [
              'property',
              property.kind,
              this.propertyKey(property.key, property.computed),
              this.expression(property.value),
            ];
          }),
        ];
      case 'ArrayExpression':
        return ['array', node.elements.map((element) => this.expression(element))];
      case 'SpreadElement':
      case 'RestElement':
        return [node.type, this.expression(node.argument)];
      case 'BlockStatement':
        return ['block', node.body.map((statement) => this.expression(statement))];
      case 'ReturnStatement':
      case 'ThrowStatement':
      case 'ExpressionStatement':
        return [node.type, this.expression(node.argument || node.expression)];
      case 'VariableDeclaration':
        return [
          'declaration',
          node.kind,
          node.declarations.map((declaration) => [
            this.pattern(declaration.id),
            this.expression(declaration.init),
          ]),
        ];
      case 'IfStatement':
        return [
          'if',
          this.expression(node.test),
          this.expression(node.consequent),
          this.expression(node.alternate),
        ];
      case 'SwitchStatement':
        return [
          'switch',
          this.expression(node.discriminant),
          node.cases.map((item) => [
            this.expression(item.test),
            item.consequent.map((statement) => this.expression(statement)),
          ]),
        ];
      case 'TSAsExpression':
      case 'TSTypeAssertion':
      case 'TSNonNullExpression':
      case 'TypeCastExpression':
      case 'ParenthesizedExpression':
        return this.expression(node.expression);
      default:
        return this.generic(node);
    }
  }

  generic(node) {
    const keys = VISITOR_KEYS[node.type];
    if (!keys) return [node.type];
    const scalars = {};
    for (const key of ['kind', 'operator', 'prefix', 'postfix', 'computed', 'optional', 'async']) {
      if (Object.prototype.hasOwnProperty.call(node, key)) scalars[key] = node[key];
    }
    return [
      node.type,
      scalars,
      keys.map((key) => {
        const value = node[key];
        if (Array.isArray(value)) return [key, value.map((child) => this.expression(child))];
        return [key, this.expression(value)];
      }),
    ];
  }

  jsxAttribute(attribute) {
    if (attribute.type === 'JSXSpreadAttribute') {
      return ['spread-attribute', this.expression(attribute.argument)];
    }
    const name = jsxName(attribute.name);
    if (!attribute.value) return ['attribute', name, ['boolean', true]];
    if (attribute.value.type === 'StringLiteral') {
      return ['attribute', name, ['string', attribute.value.value]];
    }
    if (attribute.value.type !== 'JSXExpressionContainer') {
      return ['attribute', name, this.expression(attribute.value)];
    }
    if (
      attribute.value.expression.type === 'Identifier' &&
      attribute.value.expression.name === 'undefined'
    ) {
      return null;
    }
    if (EVENT_HANDLER_ATTRIBUTE.test(name) || name === 'ref') {
      return ['attribute', name, ['behavior-expression']];
    }
    return ['attribute', name, this.expression(attribute.value.expression)];
  }

  jsxChildren(children) {
    const result = [];
    for (const child of children) {
      if (child.type === 'JSXText') {
        const text = cleanJsxText(child.value);
        if (text) result.push(['text', text]);
      } else if (
        child.type === 'JSXExpressionContainer' &&
        child.expression.type === 'JSXEmptyExpression'
      ) {
        continue;
      } else {
        result.push(this.expression(child));
      }
    }
    return result;
  }

  jsxAttributes(attributes) {
    const result = [];
    let namedGroup = [];
    const flushNamedGroup = () => {
      const names = namedGroup.map((entry) => entry[1]);
      if (new Set(names).size === names.length) {
        namedGroup.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
      }
      result.push(...namedGroup);
      namedGroup = [];
    };
    for (const attribute of attributes) {
      const fingerprint = this.jsxAttribute(attribute);
      if (!fingerprint) continue;
      if (fingerprint[0] === 'spread-attribute') {
        flushNamedGroup();
        result.push(fingerprint);
      } else {
        namedGroup.push(fingerprint);
      }
    }
    flushNamedGroup();
    return result;
  }

  jsxElement(node) {
    return [
      'element',
      jsxName(node.openingElement.name),
      this.jsxAttributes(node.openingElement.attributes),
      this.jsxChildren(node.children),
    ];
  }

  jsxFragment(node) {
    return ['fragment', this.jsxChildren(node.children)];
  }
}

function taggedTemplateName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return null;
}

function templateFingerprint(templates) {
  const serialized = templates
    .map((template) => {
      const fingerprinter = new ExpressionFingerprinter();
      const quasis = template.quasi.quasis.map(
        (quasi) => quasi.value.cooked ?? quasi.value.raw,
      );
      const expressions = template.quasi.expressions.map((expression, index) => {
        const preceding = quasis[index] || '';
        if (/@[A-Za-z][\w:.-]*\s*=\s*$/.test(preceding)) return ['behavior-expression'];
        return fingerprinter.expression(expression);
      });
      return JSON.stringify([taggedTemplateName(template.tag), quasis, expressions]);
    })
    .sort((left, right) => left.localeCompare(right, 'en'));
  return {
    hash: sha256(JSON.stringify(serialized)),
    rootCount: serialized.length,
    roots: serialized.map((template) => sha256(template)),
  };
}

function createTaggedTemplateFingerprints(source, relativePath = 'source.ts') {
  const ast = parseRenderSource(source, relativePath);
  const renderTemplates = [];
  const styleTemplates = [];
  traverse(ast, {
    TaggedTemplateExpression(astPath) {
      const name = taggedTemplateName(astPath.node.tag);
      if (name === 'html' || name === 'svg') renderTemplates.push(astPath.node);
      if (name === 'css') styleTemplates.push(astPath.node);
    },
  });
  return {
    render: templateFingerprint(renderTemplates),
    styles: templateFingerprint(styleTemplates),
  };
}

function createRenderSurfaceFingerprint(source, relativePath = 'source.jsx') {
  const ast = parseRenderSource(source, relativePath);
  const roots = [];
  traverse(ast, {
    JSXElement(astPath) {
      if (!astPath.findParent((parent) => parent.isJSXElement() || parent.isJSXFragment())) {
        roots.push(astPath.node);
      }
    },
    JSXFragment(astPath) {
      if (!astPath.findParent((parent) => parent.isJSXElement() || parent.isJSXFragment())) {
        roots.push(astPath.node);
      }
    },
  });
  const serializedRoots = roots
    .map((root) => JSON.stringify(new ExpressionFingerprinter().expression(root)))
    .sort((left, right) => left.localeCompare(right, 'en'));
  return {
    hash: sha256(JSON.stringify(serializedRoots)),
    rootCount: serializedRoots.length,
    roots: serializedRoots.map((root) => sha256(root)),
  };
}

function createManifest(provider, baselineRevision = null) {
  const exactFiles = {};
  const retiredExactFiles = baselineRevision ? {...RETIRED_EXACT_FILES} : {};
  const localeSurfaces = {};
  const renderSurfaces = {};
  for (const relativePath of provider.listFiles()) {
    if (isLocaleFile(relativePath)) {
      localeSurfaces[relativePath] = localeSurface(
        relativePath,
        provider.readFile(relativePath),
      );
      continue;
    }
    if (isRenderSource(relativePath)) {
      const source = canonicalizeRuntimeRenderSource(
        relativePath,
        provider.readFile(relativePath).toString('utf8'),
      );
      const fingerprint = createRenderSurfaceFingerprint(source, relativePath);
      if (fingerprint.rootCount > 0) {
        renderSurfaces[relativePath] = fingerprint;
        continue;
      }
    }
    if (isExactVisualFile(relativePath)) {
      const hash = hashContents(relativePath, provider.readFile(relativePath));
      if (baselineRevision && Object.hasOwn(RETIRED_EXACT_FILES, relativePath)) {
        retiredExactFiles[relativePath] = hash;
      } else {
        exactFiles[relativePath] = hash;
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    normalization: NORMALIZATION,
    baselineRevision,
    retiredExactFiles,
    exactFiles,
    localeSurfaces,
    renderSurfaces,
  };
}

function compareRecordKeys(expected, actual) {
  return {
    added: Object.keys(actual).filter((file) => !(file in expected)).sort(),
    removed: Object.keys(expected).filter((file) => !(file in actual)).sort(),
  };
}

function compareManifests(expected, actual) {
  const exactKeys = compareRecordKeys(expected.exactFiles || {}, actual.exactFiles || {});
  const renderKeys = compareRecordKeys(expected.renderSurfaces || {}, actual.renderSurfaces || {});
  const exactChanged = Object.keys(actual.exactFiles || {})
    .filter(
      (file) => file in (expected.exactFiles || {}) && actual.exactFiles[file] !== expected.exactFiles[file],
    )
    .sort();
  const renderChanged = Object.keys(actual.renderSurfaces || {})
    .filter(
      (file) =>
        file in (expected.renderSurfaces || {}) &&
        actual.renderSurfaces[file].hash !== expected.renderSurfaces[file].hash,
    )
    .sort();
  const localeRemoved = Object.keys(expected.localeSurfaces || {})
    .filter((file) => !(file in (actual.localeSurfaces || {})))
    .sort();
  const localeChanged = Object.keys(expected.localeSurfaces || {})
    .filter((file) => file in (actual.localeSurfaces || {}))
    .filter((file) => {
      const expectedSurface = expected.localeSurfaces[file];
      const actualHashes = actual.localeSurfaces[file]._leafHashes;
      if (!actualHashes) throw new Error(`locale comparison data is missing: ${file}`);
      const projection = expectedSurface.keys.map((key) => [key, actualHashes[key] ?? null]);
      return sha256(JSON.stringify(projection)) !== expectedSurface.hash;
    })
    .sort();
  return {
    exact: { ...exactKeys, changed: exactChanged },
    locale: {added: [], removed: localeRemoved, changed: localeChanged},
    render: { ...renderKeys, changed: renderChanged },
  };
}

function hasChanges(changes) {
  return ['exact', 'locale', 'render'].some((kind) =>
    ['added', 'removed', 'changed'].some((change) => changes[kind][change].length > 0),
  );
}

function formatChanges(changes) {
  const lines = [];
  const limit = 80;
  for (const [kind, label] of [
    ['exact', 'exact visual file'],
    ['locale', 'original locale values'],
    ['render', 'render surface'],
  ]) {
    for (const change of ['added', 'removed', 'changed']) {
      for (const file of changes[kind][change].slice(0, limit)) {
        lines.push(`  - ${change} ${label}: ${file}`);
      }
      if (changes[kind][change].length > limit) {
        lines.push(`  - ${change} ${label}: ... and ${changes[kind][change].length - limit} more`);
      }
    }
  }
  return lines.join('\n');
}

function validateManifest(manifest) {
  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    manifest.algorithm !== ALGORITHM ||
    manifest.normalization !== NORMALIZATION ||
    !/^[0-9a-f]{40}$/.test(manifest.baselineRevision || '') ||
    !manifest.retiredExactFiles ||
    Array.isArray(manifest.retiredExactFiles) ||
    !manifest.exactFiles ||
    Array.isArray(manifest.exactFiles) ||
    !manifest.localeSurfaces ||
    Array.isArray(manifest.localeSurfaces) ||
    !manifest.renderSurfaces ||
    Array.isArray(manifest.renderSurfaces)
  ) {
    throw new Error('visual baseline metadata is invalid or obsolete');
  }
  const retiredEntries = Object.entries(manifest.retiredExactFiles);
  if (
    retiredEntries.length !== Object.keys(RETIRED_EXACT_FILES).length ||
    retiredEntries.some(
      ([file, hash]) => RETIRED_EXACT_FILES[file] !== hash || file in manifest.exactFiles,
    )
  ) {
    throw new Error('invalid retired visual baseline entries');
  }
  for (const [file, hash] of Object.entries(manifest.exactFiles)) {
    if (!isExactVisualFile(file) || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid exact visual baseline entry: ${file}`);
    }
  }
  for (const [file, surface] of Object.entries(manifest.localeSurfaces)) {
    if (
      !isLocaleFile(file) ||
      !/^[0-9a-f]{64}$/.test(surface?.hash || '') ||
      !Array.isArray(surface?.keys) ||
      surface.keys.length === 0 ||
      surface.keys.some((key) => typeof key !== 'string' || !key || key.includes('\0')) ||
      [...surface.keys].sort((left, right) => left.localeCompare(right, 'en'))
        .some((key, index) => key !== surface.keys[index]) ||
      new Set(surface.keys).size !== surface.keys.length
    ) {
      throw new Error(`invalid locale visual baseline entry: ${file}`);
    }
  }
  for (const [file, surface] of Object.entries(manifest.renderSurfaces)) {
    if (
      !isRenderSource(file) ||
      !/^[0-9a-f]{64}$/.test(surface?.hash || '') ||
      !Number.isSafeInteger(surface?.rootCount) ||
      surface.rootCount < 1 ||
      !Array.isArray(surface.roots) ||
      surface.roots.length !== surface.rootCount ||
      surface.roots.some((root) => !/^[0-9a-f]{64}$/.test(root))
    ) {
      throw new Error(`invalid render-surface baseline entry: ${file}`);
    }
  }
}

function readExpectedManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error('visual baseline is missing');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  validateManifest(manifest);
  return manifest;
}

function writeBaseline(reference) {
  if (!reference) {
    throw new Error(
      'refusing to approve the working tree; pass --baseline-ref <reviewed-commit> to hash committed sources',
    );
  }
  const provider = createGitProvider(reference);
  const manifest = createManifest(provider, provider.revision);
  validateManifest(manifest);
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `Visual baseline schema ${SCHEMA_VERSION} written from committed revision ${provider.revision}: ` +
      `${Object.keys(manifest.exactFiles).length} exact files, ` +
      `${Object.keys(manifest.localeSurfaces).length} locale files, ` +
      `${Object.keys(manifest.renderSurfaces).length} render surfaces, and ` +
      `${Object.keys(manifest.retiredExactFiles).length} security-retired static files.`,
  );
}

function checkWorkingTree() {
  assertVisualRuntimePins();
  const expected = readExpectedManifest();
  const actual = createManifest(createWorkingTreeProvider());
  const changes = compareManifests(expected, actual);
  if (hasChanges(changes)) {
    throw new Error(
      `frontend visual contract differs from committed baseline ${expected.baselineRevision}:\n` +
        formatChanges(changes),
    );
  }
  console.log(
    `Visual freeze passed against ${expected.baselineRevision}: ` +
      `${Object.keys(actual.exactFiles).length} exact files and ` +
      `${Object.keys(actual.renderSurfaces).length} render surfaces match; ` +
      `${Object.keys(expected.localeSurfaces).length} locale files match the original or explicitly reviewed native-security copy; ` +
      `security-retired static entries absent: ${Object.keys(expected.retiredExactFiles).length}.`,
  );
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function main() {
  if (process.argv.includes('--update')) writeBaseline(argumentValue('--baseline-ref'));
  else checkWorkingTree();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Visual freeze failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ExpressionFingerprinter,
  canonicalizeLocaleValue,
  canonicalizeRuntimeRenderSource,
  cleanJsxText,
  compareManifests,
  createGitProvider,
  createManifest,
  createRenderSurfaceFingerprint,
  createTaggedTemplateFingerprints,
  createWorkingTreeProvider,
  hashContents,
  isExactVisualFile,
  isExcludedSource,
  isLocaleFile,
  isRenderSource,
  normalizeText,
  validateManifest,
};
