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

import { Cubic } from "./cubic.js";
import { RoundedPolygon, Feature } from "./roundedPolygon.js";
import { ProgressableFeature } from "./featureMapper.js";
import {
    Point,
    DistanceEpsilon,
    positiveModulo,
    debugLog
} from "./utils.js";

const LOG_TAG = "PolygonMeasure";
const DEBUG = false;

/**
 * A MeasuredCubic holds information about the cubic itself, and the outline progress values
 * (start and end) for the cubic. This information is used to match cubics between shapes that
 * lie at similar outline progress positions along their respective shapes (after matching
 * features and shifting).
 *
 * Outline progress is a value in [0..1] that represents the distance traveled along the
 * overall outline path of the shape.
 * @internal
 */
export class MeasuredCubic {
    /** @type {Cubic} */
    cubic;
    /** @type {number} */
    startOutlineProgress;
    /** @type {number} */
    endOutlineProgress;
    /** @type {Measurer} */
    #measurer;
    /** @type {number} */
    measuredSize;

    /**
     * @param {Cubic} cubic
     * @param {number} startOutlineProgress A value between 0.0 and 1.0.
     * @param {number} endOutlineProgress A value between 0.0 and 1.0.
     * @param {Measurer} measurer
     */
    constructor(cubic, startOutlineProgress, endOutlineProgress, measurer) {
        if (endOutlineProgress < startOutlineProgress) {
            // Allow for a small epsilon for floating point errors
            if (endOutlineProgress < startOutlineProgress - DistanceEpsilon) {
                throw new Error(
                   `endOutlineProgress (${endOutlineProgress}) is expected to be equal or ` +
                   `greater than startOutlineProgress (${startOutlineProgress})`
                );
            }
            endOutlineProgress = startOutlineProgress;
        }
        this.cubic = cubic;
        this.startOutlineProgress = startOutlineProgress;
        this.endOutlineProgress = endOutlineProgress;
        this.#measurer = measurer;
        this.measuredSize = this.#measurer.measureCubic(cubic);
    }

    /**
     * @param {number} [startOutlineProgress]
     * @param {number} [endOutlineProgress]
     */
    updateProgressRange(
        startOutlineProgress = this.startOutlineProgress,
        endOutlineProgress = this.endOutlineProgress
    ) {
        if (endOutlineProgress < startOutlineProgress) {
            throw new Error("endOutlineProgress is expected to be equal or greater than startOutlineProgress");
        }
        this.startOutlineProgress = startOutlineProgress;
        this.endOutlineProgress = endOutlineProgress;
    }

    /**
     * Cut this MeasuredCubic into two MeasuredCubics at the given outline progress value.
     * @param {number} cutOutlineProgress
     * @returns {[MeasuredCubic, MeasuredCubic]}
     */
    cutAtProgress(cutOutlineProgress) {
        // Floating point errors can cause cutOutlineProgress to land just slightly
        // outside of the start/end progress for this cubic, so we limit it.
        const boundedCutOutlineProgress = Math.max(
            this.startOutlineProgress,
            Math.min(cutOutlineProgress, this.endOutlineProgress)
        );

        const outlineProgressSize = this.endOutlineProgress - this.startOutlineProgress;
        const progressFromStart = boundedCutOutlineProgress - this.startOutlineProgress;

        // Note that in earlier parts of the computation, we have empty MeasuredCubics (cubics
        // with progressSize == 0), but those cubics are filtered out before this method is called.
        const relativeProgress = outlineProgressSize === 0 ? 0 : progressFromStart / outlineProgressSize;
        const t = this.#measurer.findCubicCutPoint(this.cubic, relativeProgress * this.measuredSize);
        if (t < 0 || t > 1) {
             // Allow for a small epsilon for floating point errors
            if (t < -DistanceEpsilon || t > 1 + DistanceEpsilon) {
                throw new Error(`Cubic cut point ${t} is expected to be between 0 and 1`);
            }
        }

        if (DEBUG) {
            debugLog(LOG_TAG,
                `cutAtProgress: progress = ${boundedCutOutlineProgress} / ` +
                `this = [${this.startOutlineProgress} .. ${this.endOutlineProgress}] / ` +
                `ps = ${progressFromStart} / rp = ${relativeProgress} / t = ${t}`
            );
        }

        const [c1, c2] = this.cubic.split(t);
        return [
            new MeasuredCubic(c1, this.startOutlineProgress, boundedCutOutlineProgress, this.#measurer),
            new MeasuredCubic(c2, boundedCutOutlineProgress, this.endOutlineProgress, this.#measurer)
        ];
    }

    toString() {
        return `MeasuredCubic(outlineProgress=[${this.startOutlineProgress} .. ${this.endOutlineProgress}], ` +
               `size=${this.measuredSize}, cubic=${this.cubic})`;
    }
}


/** @internal */
export class MeasuredPolygon {
    /** @type {Measurer} */
    #measurer;
    /** @type {MeasuredCubic[]} */
    #cubics;
    /** @type {ProgressableFeature[]} */
    features;

    /**
     * @param {Measurer} measurer
     * @param {ProgressableFeature[]} features
     * @param {Cubic[]} cubics
     * @param {number[]} outlineProgress
     * @private
     */
    constructor(measurer, features, cubics, outlineProgress) {
        if (outlineProgress.length !== cubics.length + 1) {
            throw new Error("Outline progress size is expected to be the cubics size + 1");
        }
        if (outlineProgress[0] !== 0) {
            throw new Error("First outline progress value is expected to be zero");
        }
        if (Math.abs(outlineProgress[outlineProgress.length - 1] - 1.0) > DistanceEpsilon) {
             throw new Error("Last outline progress value is expected to be one");
        }

        this.#measurer = measurer;
        this.features = features;

        if (DEBUG) {
            debugLog(LOG_TAG, `CTOR: cubics = ${cubics.join(", ")}\nCTOR: op = ${outlineProgress.join(", ")}`);
        }

        const measuredCubics = [];
        let startOutlineProgress = 0;
        for (let index = 0; index < cubics.length; index++) {
            // Filter out "empty" cubics
            if ((outlineProgress[index + 1] - outlineProgress[index]) > DistanceEpsilon) {
                measuredCubics.push(
                    new MeasuredCubic(
                        cubics[index],
                        startOutlineProgress,
                        outlineProgress[index + 1],
                        this.#measurer
                    )
                );
                // The next measured cubic will start exactly where this one ends.
                startOutlineProgress = outlineProgress[index + 1];
            }
        }
        // We could have removed empty cubics at the end. Ensure the last measured cubic ends at 1.0
        if (measuredCubics.length > 0) {
            measuredCubics[measuredCubics.length - 1].updateProgressRange(undefined, 1.0);
        }
        this.#cubics = measuredCubics;
    }

    /**
     * Finds the point in the input list of measured cubics that pass the given outline progress,
     * and generates a new MeasuredPolygon (equivalent to this), that starts at that point.
     * @param {number} cuttingPoint
     * @returns {MeasuredPolygon}
     */
    cutAndShift(cuttingPoint) {
        if (cuttingPoint < 0 || cuttingPoint > 1) {
            throw new Error("Cutting point is expected to be between 0 and 1");
        }
        if (cuttingPoint < DistanceEpsilon) return this;

        const targetIndex = this.#cubics.findIndex(it =>
            cuttingPoint >= it.startOutlineProgress && cuttingPoint <= it.endOutlineProgress
        );
        if (targetIndex === -1) {
            // This can happen due to floating point inaccuracies, assume it's at the end.
            if (Math.abs(cuttingPoint - 1.0) < DistanceEpsilon) {
                return this;
            }
            throw new Error(`Cutting point ${cuttingPoint} not found in any cubic range.`);
        }

        const target = this.#cubics[targetIndex];
        if (DEBUG) {
            this.#cubics.forEach((cubic, index) => debugLog(LOG_TAG, `cut&Shift | cubic #${index} : ${cubic} `));
            debugLog(LOG_TAG, `cut&Shift, cuttingPoint = ${cuttingPoint}, target = (${targetIndex}) ${target}`);
        }

        const [b1, b2] = target.cutAtProgress(cuttingPoint);
        if (DEBUG) debugLog(LOG_TAG, `Split | ${target} -> ${b1} & ${b2}`);

        const retCubics = [b2.cubic];
        for (let i = 1; i < this.#cubics.length; i++) {
            retCubics.push(this.#cubics[(i + targetIndex) % this.#cubics.length].cubic);
        }
        retCubics.push(b1.cubic);

        const retOutlineProgress = [0];
        for (let index = 1; index < retCubics.length; index++) {
            const cubicIndex = (targetIndex + index - 1) % this.#cubics.length;
            retOutlineProgress.push(
                positiveModulo(this.#cubics[cubicIndex].endOutlineProgress - cuttingPoint, 1.0)
            );
        }
        retOutlineProgress.push(1.0);

        const newFeatures = this.features.map(f =>
            new ProgressableFeature(
                positiveModulo(f.progress - cuttingPoint, 1.0),
                f.feature
            )
        );

        return new MeasuredPolygon(this.#measurer, newFeatures, retCubics, retOutlineProgress);
    }

    get size() { return this.#cubics.length; }

    get(index) { return this.#cubics[index]; }

    [Symbol.iterator]() { return this.#cubics[Symbol.iterator](); }

    /**
     * @param {Measurer} measurer
     * @param {RoundedPolygon} polygon
     * @returns {MeasuredPolygon}
     */
    static measurePolygon(measurer, polygon) {
        const cubics = [];
        const featureToCubic = [];

        for (const feature of polygon.features) {
            for (let cubicIndex = 0; cubicIndex < feature.cubics.length; cubicIndex++) {
                if (feature.isCorner && cubicIndex === Math.floor(feature.cubics.length / 2)) {
                    featureToCubic.push({ feature, index: cubics.length });
                }
                cubics.push(feature.cubics[cubicIndex]);
            }
        }

        const measures = [0];
        let totalMeasure = 0;
        for (const cubic of cubics) {
            const measure = measurer.measureCubic(cubic);
            if (measure < 0) {
                throw new Error("Measured cubic is expected to be greater or equal to zero");
            }
            totalMeasure += measure;
            measures.push(totalMeasure);
        }

        const outlineProgress = measures.map(m => totalMeasure === 0 ? 0 : m / totalMeasure);
        if(outlineProgress.length > 0) {
            outlineProgress[outlineProgress.length - 1] = 1.0; // Ensure it ends exactly at 1.0
        }


        if (DEBUG) debugLog(LOG_TAG, `Total size: ${totalMeasure}`);

        const features = featureToCubic.map(({ feature, index }) => {
            const progress = positiveModulo(
                (outlineProgress[index] + outlineProgress[index + 1]) / 2,
                1.0
            );
            return new ProgressableFeature(progress, feature);
        });

        return new MeasuredPolygon(measurer, features, cubics, outlineProgress);
    }
}

/**
 * Interface for measuring a cubic.
 * @internal
 */
export class Measurer {
    /**
     * Returns size of given cubic. It has to be greater or equal to 0.
     * @param {Cubic} c
     * @returns {number}
     */
    measureCubic(c) {
        throw new Error("Not implemented");
    }

    /**
     * Given a cubic and a measure, finds the parameter t of the cubic at which that measure is reached.
     * @param {Cubic} c
     * @param {number} m
     * @returns {number}
     */
    findCubicCutPoint(c, m) {
        throw new Error("Not implemented");
    }
}

/**
 * Approximates the arc lengths of cubics by splitting the arc into segments.
 * @internal
 */
export class LengthMeasurer extends Measurer {
    #segments = 3;

    measureCubic(c) {
        return this.#closestProgressTo(c, Infinity).second;
    }

    findCubicCutPoint(c, m) {
        return this.#closestProgressTo(c, m).first;
    }

    /**
     * @param {Cubic} cubic
     * @param {number} threshold
     * @returns {{first: number, second: number}} A pair of (progress, total length)
     * @private
     */
    #closestProgressTo(cubic, threshold) {
        let total = 0;
        let remainder = threshold;
        let prev = new Point(cubic.anchor0X, cubic.anchor0Y);

        for (let i = 1; i <= this.#segments; i++) {
            const progress = i / this.#segments;
            const point = cubic.pointOnCurve(progress);
            const segment = point.minus(prev).getDistance();

            if (segment >= remainder) {
                const p = progress - (1.0 - remainder / segment) / this.#segments;
                return { first: p, second: threshold };
            }

            remainder -= segment;
            total += segment;
            prev = point;
        }

        return { first: 1.0, second: total };
    }
}


