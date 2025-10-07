/*
 * Copyright 2023 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Feature } from './roundedPolygon.js';
import { Point, DistanceEpsilon, debugLog } from './utils.js';
import { DoubleMapper } from './floatMapping.js';

const LOG_TAG = "FeatureMapping";
const DEBUG = true;

/**
 * A feature with its progress along the polygon's outline.
 * @internal
 */
export class ProgressableFeature {
    /**
     * @param {number} progress - The progress value [0..1].
     * @param {Feature} feature - The feature itself.
     */
    constructor(progress, feature) {
        this.progress = progress;
        this.feature = feature;
    }
}

/**
 * A list of all features in a polygon along with their progress.
 * @typedef {ProgressableFeature[]} MeasuredFeatures
 */

/**
 * A vertex in the distance graph, connecting a feature from each polygon.
 * @private
 */
class DistanceVertex {
    /**
     * @param {number} distance
     * @param {ProgressableFeature} f1
     * @param {ProgressableFeature} f2
     */
    constructor(distance, f1, f2) {
        this.distance = distance;
        this.f1 = f1;
        this.f2 = f2;
    }
}

/**
 * Creates a mapping between the "features" (rounded corners) of two shapes.
 * @param {MeasuredFeatures} features1
 * @param {MeasuredFeatures} features2
 * @returns {DoubleMapper}
 * @internal
 */
export function featureMapper(features1, features2) {
    // We only use corners for this mapping.
    const filteredFeatures1 = [];
    for (const f of features1) {
        if (f.feature.isCorner) {
            filteredFeatures1.push(f);
        }
    }

    const filteredFeatures2 = [];
    for (const f of features2) {
        if (f.feature.isCorner) {
            filteredFeatures2.push(f);
        }
    }

    const featureProgressMapping = doMapping(filteredFeatures1, filteredFeatures2);

    if (DEBUG) {
        debugLog(LOG_TAG, featureProgressMapping.map(p => `${p.first} -> ${p.second}`).join(', '));
    }

    // DoubleMapper constructor expects individual mapping objects as arguments, not an array
    const dm = new DoubleMapper(...featureProgressMapping);

    if (DEBUG) {
        const N = 10;
        const toFixed = (n) => n.toFixed(3);
        const mapValues = Array.from({ length: N + 1 }, (_, i) => toFixed(dm.map(i / N))).join(', ');
        const mapBackValues = Array.from({ length: N + 1 }, (_, i) => toFixed(dm.mapBack(i / N))).join(', ');
        debugLog(LOG_TAG, `Map: ${mapValues}\nMb : ${mapBackValues}`);
    }
    return dm;
}

/**
 * Returns a mapping of the features between features1 and features2.
 * The return is a list of pairs where the first element is the progress of a feature
 * in features1 and the second is the progress of the mapped feature in features2.
 * @param {ProgressableFeature[]} features1
 * @param {ProgressableFeature[]} features2
 * @returns {{first: number, second: number}[]}
 * @private
 */
function doMapping(features1, features2) {
    if (DEBUG) {
        debugLog(LOG_TAG, `Shape1 progresses: ${features1.map(f => f.progress).join(', ')}`);
        debugLog(LOG_TAG, `Shape2 progresses: ${features2.map(f => f.progress).join(', ')}`);
    }

    const distanceVertexList = [];
    for (const f1 of features1) {
        for (const f2 of features2) {
            const d = featureDistSquared(f1.feature, f2.feature);
            if (d !== Number.MAX_VALUE) {
                distanceVertexList.push(new DistanceVertex(d, f1, f2));
            }
        }
    }
    distanceVertexList.sort((a, b) => a.distance - b.distance);

    // Special cases.
    if (distanceVertexList.length === 0) return IdentityMapping;
    if (distanceVertexList.length === 1) {
        const { f1, f2 } = distanceVertexList[0];
        const p1 = f1.progress;
        const p2 = f2.progress;
        return [
            { first: p1, second: p2 },
            { first: (p1 + 0.5) % 1, second: (p2 + 0.5) % 1 }
        ];
    }

    const helper = new MappingHelper();
    distanceVertexList.forEach(vertex => helper.addMapping(vertex.f1, vertex.f2));
    return helper.mapping;
}

const IdentityMapping = [{ first: 0, second: 0 }, { first: 0.5, second: 0.5 }];

/** Helper for `binarySearchBy` */
function binarySearchBy(sortedArray, key, selector) {
    let low = 0;
    let high = sortedArray.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const midVal = selector(sortedArray[mid]);
        if (midVal < key) low = mid + 1;
        else if (midVal > key) high = mid - 1;
        else return mid;
    }
    return -(low + 1);
}

/** Helper for `MappingHelper` */
function progressDistance(p1, p2) {
    const d = Math.abs(p1 - p2);
    return Math.min(d, 1 - d);
}

/** Helper for `MappingHelper` */
function progressInRange(p, start, end) {
    return start <= end ? p >= start && p <= end : p >= start || p <= end;
}

/** @private */
class MappingHelper {
    constructor() {
        this.mapping = []; // {first: number, second: number}[]
        this.usedF1 = new Set(); // Set<ProgressableFeature>
        this.usedF2 = new Set(); // Set<ProgressableFeature>
    }

    addMapping(f1, f2) {
        if (this.usedF1.has(f1) || this.usedF2.has(f2)) return;

        const index = binarySearchBy(this.mapping, f1.progress, item => item.first);
        if (index >= 0) {
            // This should not happen if all features have unique progress values.
            return;
        }

        const insertionIndex = -index - 1;
        const n = this.mapping.length;

        if (n >= 1) {
            const before = this.mapping[(insertionIndex + n - 1) % n];
            const after = this.mapping[insertionIndex % n];

            if (
                progressDistance(f1.progress, before.first) < DistanceEpsilon ||
                progressDistance(f1.progress, after.first) < DistanceEpsilon ||
                progressDistance(f2.progress, before.second) < DistanceEpsilon ||
                progressDistance(f2.progress, after.second) < DistanceEpsilon
            ) {
                return;
            }

            if (n > 1 && !progressInRange(f2.progress, before.second, after.second)) {
                return;
            }
        }

        this.mapping.splice(insertionIndex, 0, { first: f1.progress, second: f2.progress });
        this.usedF1.add(f1);
        this.usedF2.add(f2);
    }
}

/**
 * Returns squared distance between two Features on two different shapes.
 * @internal
 */
function featureDistSquared(f1, f2) {
    if (f1.isCorner && f2.isCorner && f1.convex !== f2.convex) {
        if (DEBUG) debugLog(LOG_TAG, "*** Feature distance ∞ for convex-vs-concave corners");
        return Number.MAX_VALUE;
    }
    const p1 = featureRepresentativePoint(f1);
    const p2 = featureRepresentativePoint(f2);
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return dx * dx + dy * dy;
}

/**
 * Gets a representative point for a feature, used for distance calculations.
 * @internal
 */
function featureRepresentativePoint(feature) {
    const firstCubic = feature.cubics[0];
    const lastCubic = feature.cubics[feature.cubics.length - 1];
    const x = (firstCubic.anchor0X + lastCubic.anchor1X) / 2;
    const y = (firstCubic.anchor0Y + lastCubic.anchor1Y) / 2;
    return new Point(x, y);
}