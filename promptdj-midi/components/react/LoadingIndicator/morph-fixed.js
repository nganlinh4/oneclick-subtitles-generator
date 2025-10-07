/*
 * Copyright 2022 The Android Open Source Project
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

import { RoundedPolygon } from "./roundedPolygon.js";
import { Cubic, MutableCubic, createCubic } from "./cubic.js";
import { MeasuredPolygon, LengthMeasurer } from "./measuredPolygon.js";
import { featureMapper } from "./featureMapper.js";
import { interpolate, positiveModulo, AngleEpsilon, debugLog, Point } from "./utils.js";

const LOG_TAG = "Morph";
// Set to true to enable debug logging
const DEBUG = false;

/**
 * This class is used to animate between start and end polygons objects.
 *
 * Morphing between arbitrary objects can be problematic because it can be difficult to determine
 * how the points of a given shape map to the points of some other shape. [Morph] simplifies the
 * problem by only operating on [RoundedPolygon] objects, which are known to have similar,
 * contiguous structures. For one thing, the shape of a polygon is contiguous from start to end
 * (compared to an arbitrary Path object, which could have one or more `moveTo` operations in the
 * shape). Also, all edges of a polygon shape are represented by [Cubic] objects, thus the start and
 * end shapes use similar operations. Two Polygon shapes then only differ in the quantity and
 * placement of their curves. The morph works by determining how to map the curves of the two shapes
 * together (based on proximity and other information, such as distance to polygon vertices and
 * concavity), and splitting curves when the shapes do not have the same number of curves or when
 * the curve placement within the shapes is very different.
 */
export class Morph {
    #start;
    #end;

    /**
     * The structure which holds the actual shape being morphed. It contains all cubics necessary to
     * represent the start and end shapes (the original cubics in the shapes may be cut to align the
     * start/end shapes), matched one to one in each Pair.
     * @private
     */
    #morphMatch;

    /**
     * @param {RoundedPolygon} start
     * @param {RoundedPolygon} end
     */
    constructor(start, end) {
        this.#start = start;
        this.#end = end;
        this.#morphMatch = Morph.match(start, end);
    }

    /**
     * The structure which holds the actual shape being morphed. It contains all cubics necessary to
     * represent the start and end shapes (the original cubics in the shapes may be cut to align the
     * start/end shapes), matched one to one. Each element of the array is an object
     * `{ first: Cubic, second: Cubic }`.
     * @returns {Array<{first: Cubic, second: Cubic}>}
     */
    get morphMatch() {
        return this.#morphMatch;
    }

    /**
     * Returns the bounds of the morph object at a given `progress` value.
     * @param {number} progress - A value from 0 to 1 that determines the morph's current shape.
     * @returns {number[]} An array of [left, top, right, bottom] bounds.
     */
    bounds(progress) {
        if (this.#morphMatch.length === 0) {
            return [0, 0, 0, 0];
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (const pair of this.#morphMatch) {
            const points = new Float32Array(8);
            for (let j = 0; j < 8; j++) {
                points[j] = interpolate(pair.first.points[j], pair.second.points[j], progress);
            }

            // Check all points in the cubic
            for (let i = 0; i < 8; i += 2) {
                const x = points[i];
                const y = points[i + 1];
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }

        const bounds = [minX, minY, maxX, maxY];
        bounds[3] = Math.max(maxY, bounds[3]);
        return bounds;
    }

    /**
     * Returns a representation of the morph object at a given `progress` value as a list of Cubics.
     * Note that this function causes a new list to be created and populated, so there is some
     * overhead.
     *
     * @param {number} progress - A value from 0 to 1 that determines the morph's current shape,
     *   between the start and end shapes provided at construction time. A value of 0 results in the
     *   start shape, a value of 1 results in the end shape, and any value in between results in a
     *   shape which is a linear interpolation between those two shapes. The range is generally
     *   [0..1] and values outside could result in undefined shapes, but values close to (but
     *   outside) the range can be used to get an exaggerated effect (e.g., for a bounce or
     *   overshoot animation).
     * @returns {Cubic[]} A new array of `Cubic` objects representing the morphed shape.
     */
    asCubics(progress) {
        const result = [];
        if (this.#morphMatch.length === 0) {
            return result;
        }
        // The first/last mechanism here ensures that the final anchor point in the shape
        // exactly matches the first anchor point. There can be rendering artifacts introduced
        // by those points being slightly off, even by much less than a pixel.
        let firstCubic = null;
        let lastCubic = null;
        for (let i = 0; i < this.#morphMatch.length; i++) {
            const pair = this.#morphMatch[i];
            const points = new Float32Array(8);
            for (let j = 0; j < 8; j++) {
                points[j] = interpolate(pair.first.points[j], pair.second.points[j], progress);
            }
            const cubic = new Cubic(points);
            if (firstCubic === null) {
                firstCubic = cubic;
            }
            if (lastCubic !== null) {
                result.push(lastCubic);
            }
            lastCubic = cubic;
        }
        if (lastCubic !== null && firstCubic !== null) {
            // FIXED: Use createCubic instead of new Cubic with individual arguments
            result.push(
                createCubic(
                    lastCubic.anchor0X,
                    lastCubic.anchor0Y,
                    lastCubic.control0X,
                    lastCubic.control0Y,
                    lastCubic.control1X,
                    lastCubic.control1Y,
                    firstCubic.anchor0X,
                    firstCubic.anchor0Y
                )
            );
        }
        return result;
    }

    /**
     * Returns a representation of the morph object at a given `progress` value, iterating over the
     * cubics and calling the callback. This function is faster than `asCubics`, since it doesn't
     * allocate new `Cubic` instances, but to do this it reuses the same `MutableCubic` instance
     * during iteration.
     *
     * @param {number} progress - A value from 0 to 1 that determines the morph's current shape.
     * @param {(cubic: MutableCubic) => void} callback - The function to be called for each Cubic.
     * @param {MutableCubic} [mutableCubic=new MutableCubic()] - An instance of `MutableCubic` that
     *   will be used to set each cubic in time.
     */
    forEachCubic(progress, callback, mutableCubic = new MutableCubic()) {
        for (let i = 0; i < this.#morphMatch.length; i++) {
            const pair = this.#morphMatch[i];
            mutableCubic.interpolate(pair.first, pair.second, progress);
            callback(mutableCubic);
        }
    }

    /**
     * `match`, called at Morph construction time, creates the structure used to animate between
     * the start and end shapes. The technique is to match geometry (curves) between the shapes
     * when and where possible, and to create new/placeholder curves when necessary (when one of
     * the shapes has more curves than the other). The result is a list of pairs of Cubic
     * curves. Those curves are the matched pairs: the first of each pair holds the geometry of
     * the start shape, the second holds the geometry for the end shape. Changing the progress
     * of a Morph object simply interpolates between all pairs of curves for the morph shape.
     *
     * Curves on both shapes are matched by running a `Measurer` to determine where the points
     * are in each shape (proportionally, along the outline), and then running `featureMapper`
     * which decides how to map (match) all of the curves with each other.
     *
     * @param {RoundedPolygon} p1
     * @param {RoundedPolygon} p2
     * @returns {Array<{first: Cubic, second: Cubic}>}
     * @private
     */
    static match(p1, p2) {
        // Measure the polygons. This gives us a list of measured cubics for each polygon, which
        // we then use to match start/end curves
        const measuredPolygon1 = MeasuredPolygon.measurePolygon(new LengthMeasurer(), p1);
        const measuredPolygon2 = MeasuredPolygon.measurePolygon(new LengthMeasurer(), p2);

        // features1 and 2 will contain the list of corners (just the inner circular curve)
        // along with the progress at the middle of those corners. These measurement values
        // are then used to compare and match between the two polygons
        const features1 = measuredPolygon1.features;
        const features2 = measuredPolygon2.features;

        // Map features: doubleMapper is the result of mapping the features in each shape to the
        // closest feature in the other shape.
        // Given a progress in one of the shapes it can be used to find the corresponding
        // progress in the other shape (in both directions)
        const doubleMapper = featureMapper(features1, features2);

        // cut point on poly2 is the mapping of the 0 point on poly1
        const polygon2CutPoint = doubleMapper.map(0);
        if (DEBUG) debugLog(LOG_TAG, `polygon2CutPoint = ${polygon2CutPoint}`);

        // Cut and rotate.
        // Polygons start at progress 0, and the featureMapper has decided that we want to match
        // progress 0 in the first polygon to `polygon2CutPoint` on the second polygon.
        // So we need to cut the second polygon there and "rotate it", so as we walk through
        // both polygons we can find the matching.
        // The resulting bs1/2 are MeasuredPolygons, whose MeasuredCubics start from
        // outlineProgress=0 and increasing until outlineProgress=1
        const bs1 = measuredPolygon1;
        const bs2 = measuredPolygon2.cutAndShift(polygon2CutPoint);

        if (DEBUG) {
            for (let index = 0; index < bs1.size; index++) {
                const b1 = bs1.get(index);
                debugLog(LOG_TAG, `bs1[${index}] = ${b1.startOutlineProgress} .. ${b1.endOutlineProgress}`);
            }
            for (let index = 0; index < bs2.size; index++) {
                const b2 = bs2.get(index);
                debugLog(LOG_TAG, `bs2[${index}] = ${b2.startOutlineProgress} .. ${b2.endOutlineProgress}`);
            }
        }

        // Match
        // Now we can compare the two lists of measured cubics and create a list of pairs
        // of cubics [ret], which are the start/end curves that represent the Morph object
        // and the start and end shapes, and which can be interpolated to animate the
        // between those shapes.
        const ret = [];
        // i1/i2 are the indices of the current cubic on the start (1) and end (2) shapes
        let i1 = 0;
        let i2 = 0;
        // b1, b2 are the current measured cubic for each polygon
        let b1 = bs1.get(i1++);
        let b2 = bs2.get(i2++);
        // Iterate until all curves are accounted for and matched
        while (b1 && b2) {
            // Progresses are in shape1's perspective
            // b1a, b2a are ending progress values of current measured cubics in [0,1] range
            const b1a = (i1 === bs1.size) ? 1.0 : b1.endOutlineProgress;
            const b2a = (i2 === bs2.size) ? 1.0 :
                doubleMapper.mapBack(
                    positiveModulo(b2.endOutlineProgress + polygon2CutPoint, 1.0)
                );
            const minb = Math.min(b1a, b2a);
            if (DEBUG) debugLog(LOG_TAG, `${b1a} ${b2a} | ${minb}`);

            // minb is the progress at which the curve that ends first ends.
            // If both curves end roughly there, no cutting is needed, we have a match.
            // If one curve extends beyond, we need to cut it.
            let seg1, newb1;
            if (b1a > minb + AngleEpsilon) {
                if (DEBUG) debugLog(LOG_TAG, "Cut 1");
                [seg1, newb1] = b1.cutAtProgress(minb);
            } else {
                seg1 = b1;
                newb1 = bs1.get(i1++);
            }

            let seg2, newb2;
            if (b2a > minb + AngleEpsilon) {
                if (DEBUG) debugLog(LOG_TAG, "Cut 2");
                [seg2, newb2] = b2.cutAtProgress(
                    positiveModulo(doubleMapper.map(minb) - polygon2CutPoint, 1.0)
                );
            } else {
                seg2 = b2;
                newb2 = bs2.get(i2++);
            }

            ret.push({ first: seg1.cubic, second: seg2.cubic });
            b1 = newb1;
            b2 = newb2;
        }

        return ret;
    }
}
