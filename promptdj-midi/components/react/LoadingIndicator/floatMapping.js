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

import { positiveModulo, DistanceEpsilon } from './utils.js';

/**
 * Checks if the given progress is in the given progress range. Since progress is in the [0..1)
 * interval and wraps, there is a special case when `progressTo` < `progressFrom`. For example,
 * if the progress range is 0.7 to 0.2, both 0.8 and 0.1 are inside, and 0.5 is outside.
 * @internal
 * @param {number} progress The progress value to check.
 * @param {number} progressFrom The start of the range.
 * @param {number} progressTo The end of the range.
 * @returns {boolean} True if the progress is within the range.
 */
export function progressInRange(progress, progressFrom, progressTo) {
    if (progressTo >= progressFrom) {
        return progress >= progressFrom && progress <= progressTo;
    } else {
        // The range wraps around (e.g., 0.8 to 0.2)
        return progress >= progressFrom || progress <= progressTo;
    }
}

/**
 * Maps from one set of progress values to another. This is used by DoubleMapper to retrieve the
 * value on one shape that maps to the appropriate value on the other.
 * @internal
 * @param {number[]} xValues The source progress values.
 * @param {number[]} yValues The target progress values.
 * @param {number} x The source value to map.
 * @returns {number} The mapped value in the target space.
 */
export function linearMap(xValues, yValues, x) {
    // Safety check for NaN or invalid arrays
    if (isNaN(x) || !xValues || !yValues || xValues.length === 0 || yValues.length === 0) {
        console.error(`❌ linearMap: Invalid input - x=${x}, xValues=${xValues}, yValues=${yValues}`);
        return 0; // Return safe default
    }

    // Check for NaN values in arrays
    if (xValues.some(isNaN) || yValues.some(isNaN)) {
        console.error(`❌ linearMap: NaN values in arrays - xValues=${xValues}, yValues=${yValues}`);
        return 0; // Return safe default
    }

    if (x < 0 || x > 1) {
        if (x < -DistanceEpsilon || x > 1 + DistanceEpsilon) {
            throw new Error(`Invalid progress: ${x}`);
        }
        x = Math.max(0, Math.min(1, x));
    }

    let segmentStartIndex = -1;
    for (let i = 0; i < xValues.length; i++) {
        if (progressInRange(x, xValues[i], xValues[(i + 1) % xValues.length])) {
            segmentStartIndex = i;
            break;
        }
    }

    // This should always be found if the input is correct, but as a fallback for floating
    // point issues, find the closest start index.
    if (segmentStartIndex === -1) {
        let minDist = Infinity;
        for (let i = 0; i < xValues.length; i++) {
            const dist = progressDistance(x, xValues[i]);
            if (dist < minDist) {
                minDist = dist;
                segmentStartIndex = i;
            }
        }
    }

    const segmentEndIndex = (segmentStartIndex + 1) % xValues.length;
    const segmentSizeX = positiveModulo(xValues[segmentEndIndex] - xValues[segmentStartIndex], 1);
    const segmentSizeY = positiveModulo(yValues[segmentEndIndex] - yValues[segmentStartIndex], 1);

    const positionInSegment = (segmentSizeX < 0.001) ?
        0.5 :
        positiveModulo(x - xValues[segmentStartIndex], 1) / segmentSizeX;

    return positiveModulo(yValues[segmentStartIndex] + segmentSizeY * positionInSegment, 1);
}

/**
 * DoubleMapper creates mappings from values in the [0..1) source space to values in the
 * [0..1) target space, and back. This mapping is created given a finite list of representative
 * mappings, and this is extended to the whole interval by linear interpolation, and wrapping
 * around.
 * @internal
 */
export class DoubleMapper {
    #sourceValues;
    #targetValues;

    /**
     * @param  {...{first: number, second: number}} mappings - A variable number of mapping pairs.
     */
    constructor(...mappings) {
        this.#sourceValues = new Array(mappings.length);
        this.#targetValues = new Array(mappings.length);

        for (let i = 0; i < mappings.length; i++) {
            this.#sourceValues[i] = mappings[i].first;
            this.#targetValues[i] = mappings[i].second;
        }

        validateProgress(this.#sourceValues);
        validateProgress(this.#targetValues);
    }

    /** Maps a value from the source space to the target space. */
    map(x) {
        return linearMap(this.#sourceValues, this.#targetValues, x);
    }

    /** Maps a value from the target space back to the source space. */
    mapBack(x) {
        return linearMap(this.#targetValues, this.#sourceValues, x);
    }

    /** An identity mapper that maps any value to itself. */
    static Identity = new DoubleMapper({
        first: 0,
        second: 0
    }, {
        first: 0.5,
        second: 0.5
    }, );
}

/**
 * Verifies that a list of progress values is valid: all in [0, 1), monotonically
 * increasing with at most one wrap-around, and no two points are too close.
 * @internal
 * @param {number[]} p - The list of progress values.
 */
export function validateProgress(p) {
    if (p.length === 0) return;
    let prev = p[p.length - 1];
    let wraps = 0;
    for (let i = 0; i < p.length; i++) {
        const curr = p[i];
        if (curr < 0 || curr >= 1) {
            throw new Error(`FloatMapping - Progress outside of range: ${p.join(', ')}`);
        }
        // Using <= to be safe with float comparisons
        if (progressDistance(curr, prev) <= DistanceEpsilon) {
            throw new Error(`FloatMapping - Progress repeats a value: ${p.join(', ')}`);
        }
        if (curr < prev) {
            wraps++;
            if (wraps > 1) {
                throw new Error(`FloatMapping - Progress wraps more than once: ${p.join(', ')}`);
            }
        }
        prev = curr;
    }
}

/**
 * Calculates the shortest distance between two progress values on a circle of circumference 1.
 * For example, the distance between 0.9 and 0.1 is 0.2, not 0.8.
 * @internal
 * @param {number} p1
 * @param {number} p2
 * @returns {number}
 */
export function progressDistance(p1, p2) {
    const d = Math.abs(p1 - p2);
    return Math.min(d, 1 - d);
}