// Platform-aware path identity and containment checks.

import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

export const sameCanonicalPath = (left, right) => (
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
);

export const hasTraversalSegment = (input) => String(input)
  .split(/[\\/]+/u)
  .some((segment) => segment === '.' || segment === '..');

export const sameResolvedPath = (left, right) => sameCanonicalPath(resolve(left), resolve(right));

export const sameOrChildPath = (candidate, parent) => {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === '' || (
    pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
  );
};
