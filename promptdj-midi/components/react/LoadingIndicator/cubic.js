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

import {
    Point,
    convex,
    DistanceEpsilon,
    interpolate,
    directionVector,
    distance as math_distance // aliasing to avoid conflict with a potential method
} from "./utils.js"; // Assumed utility file

/**
 * @typedef {object} TransformResult
 * @property {number} first - The transformed x-coordinate.
 * @property {number} second - The transformed y-coordinate.
 */

/**
 * Interface for a function that can transform (rotate/scale/translate/etc.) points.
 * @callback PointTransformer
 * @param {number} x - The x-coordinate of the point to transform.
 * @param {number} y - The y-coordinate of the point to transform.
 * @returns {TransformResult} The transformed point.
 */

/**
 * @typedef {object} MutablePoint
 * @property {number} x
 * @property {number} y
 */


/**
 * This class holds the anchor and control point data for a single cubic Bézier curve, with anchor
 * points at either end and control points determining the slope of the curve
 * between the anchor points.
 */
export class Cubic {
    /** @internal */
    points;

    /**
     * @param {Float32Array|number[]|number} [points=new Float32Array(8)] - Array of 8 points or first coordinate
     * @param {number} [anchor0Y] - If first param is number, this is anchor0Y
     * @param {number} [control0X] - control0X coordinate
     * @param {number} [control0Y] - control0Y coordinate
     * @param {number} [control1X] - control1X coordinate
     * @param {number} [control1Y] - control1Y coordinate
     * @param {number} [anchor1X] - anchor1X coordinate
     * @param {number} [anchor1Y] - anchor1Y coordinate
     */
    constructor(points = new Float32Array(8), anchor0Y, control0X, control0Y, control1X, control1Y, anchor1X, anchor1Y) {
        // Handle overloaded constructor: either array or 8 individual coordinates
        if (typeof points === 'number' && arguments.length === 8) {
            // Called with 8 individual coordinates
            this.points = new Float32Array([
                points, anchor0Y, control0X, control0Y,
                control1X, control1Y, anchor1X, anchor1Y
            ]);
        } else {
            // Called with array
            if (points.length !== 8) {
                throw new Error("Points array size should be 8");
            }
            this.points = points instanceof Float32Array ? points : new Float32Array(points);
        }
    }

    /** The first anchor point x coordinate */
    get anchor0X() { return this.points[0]; }
    /** The first anchor point y coordinate */
    get anchor0Y() { return this.points[1]; }
    /** The first control point x coordinate */
    get control0X() { return this.points[2]; }
    /** The first control point y coordinate */
    get control0Y() { return this.points[3]; }
    /** The second control point x coordinate */
    get control1X() { return this.points[4]; }
    /** The second control point y coordinate */
    get control1Y() { return this.points[5]; }
    /** The second anchor point x coordinate */
    get anchor1X() { return this.points[6]; }
    /** The second anchor point y coordinate */
    get anchor1Y() { return this.points[7]; }

    /**
     * Returns a point on the curve for parameter t, representing the proportional distance along
     * the curve between its starting point at anchor0 and ending point at anchor1.
     *
     * @param {number} t The distance along the curve between the anchor points, where 0 is at
     *   anchor0 and 1 is at anchor1.
     * @returns {Point}
     * @internal
     */
    pointOnCurve(t) {
        const u = 1 - t;
        const u2 = u * u;
        const u3 = u2 * u;
        const t2 = t * t;
        const t3 = t2 * t;

        return new Point(
            this.anchor0X * u3 +
            this.control0X * (3 * t * u2) +
            this.control1X * (3 * t2 * u) +
            this.anchor1X * t3,
            this.anchor0Y * u3 +
            this.control0Y * (3 * t * u2) +
            this.control1Y * (3 * t2 * u) +
            this.anchor1Y * t3,
        );
    }

    /** @internal */
    zeroLength() {
        return Math.abs(this.anchor0X - this.anchor1X) < DistanceEpsilon &&
               Math.abs(this.anchor0Y - this.anchor1Y) < DistanceEpsilon;
    }

    /** @internal */
    convexTo(next) {
        const prevVertex = new Point(this.anchor0X, this.anchor0Y);
        const currVertex = new Point(this.anchor1X, this.anchor1Y);
        const nextVertex = new Point(next.anchor1X, next.anchor1Y);
        return convex(prevVertex, currVertex, nextVertex);
    }

    /** @private */
    zeroIsh(value) {
        return Math.abs(value) < DistanceEpsilon;
    }

    /**
     * This function returns the true bounds of this curve, filling `bounds` with the axis-aligned
     * bounding box values for left, top, right, and bottom, in that order.
     * @param {Float32Array} [bounds=new Float32Array(4)]
     * @param {boolean} [approximate=false]
     * @internal
     */
    calculateBounds(bounds = new Float32Array(4), approximate = false) {
        if (this.zeroLength()) {
            bounds[0] = this.anchor0X;
            bounds[1] = this.anchor0Y;
            bounds[2] = this.anchor0X;
            bounds[3] = this.anchor0Y;
            return;
        }

        let minX = Math.min(this.anchor0X, this.anchor1X);
        let minY = Math.min(this.anchor0Y, this.anchor1Y);
        let maxX = Math.max(this.anchor0X, this.anchor1X);
        let maxY = Math.max(this.anchor0Y, this.anchor1Y);

        if (approximate) {
            bounds[0] = Math.min(minX, this.control0X, this.control1X);
            bounds[1] = Math.min(minY, this.control0Y, this.control1Y);
            bounds[2] = Math.max(maxX, this.control0X, this.control1X);
            bounds[3] = Math.max(maxY, this.control0Y, this.control1Y);
            return;
        }

        // Find derivative roots for X
        const xa = -this.anchor0X + 3 * this.control0X - 3 * this.control1X + this.anchor1X;
        const xb = 2 * this.anchor0X - 4 * this.control0X + 2 * this.control1X;
        const xc = -this.anchor0X + this.control0X;

        if (this.zeroIsh(xa)) {
            if (xb !== 0) {
                const t = -xc / xb;
                if (t >= 0 && t <= 1) {
                    const x = this.pointOnCurve(t).x;
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                }
            }
        } else {
            const xs = xb * xb - 4 * xa * xc;
            if (xs >= 0) {
                const sqrtXs = Math.sqrt(xs);
                const t1 = (-xb + sqrtXs) / (2 * xa);
                if (t1 >= 0 && t1 <= 1) {
                    const x = this.pointOnCurve(t1).x;
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                }
                const t2 = (-xb - sqrtXs) / (2 * xa);
                if (t2 >= 0 && t2 <= 1) {
                    const x = this.pointOnCurve(t2).x;
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                }
            }
        }

        // Find derivative roots for Y
        const ya = -this.anchor0Y + 3 * this.control0Y - 3 * this.control1Y + this.anchor1Y;
        const yb = 2 * this.anchor0Y - 4 * this.control0Y + 2 * this.control1Y;
        const yc = -this.anchor0Y + this.control0Y;

        if (this.zeroIsh(ya)) {
            if (yb !== 0) {
                const t = -yc / yb;
                if (t >= 0 && t <= 1) {
                    const y = this.pointOnCurve(t).y;
                    minY = Math.min(minY, y);
                    maxY = Math.max(maxY, y);
                }
            }
        } else {
            const ys = yb * yb - 4 * ya * yc;
            if (ys >= 0) {
                const sqrtYs = Math.sqrt(ys);
                const t1 = (-yb + sqrtYs) / (2 * ya);
                if (t1 >= 0 && t1 <= 1) {
                    const y = this.pointOnCurve(t1).y;
                    minY = Math.min(minY, y);
                    maxY = Math.max(maxY, y);
                }
                const t2 = (-yb - sqrtYs) / (2 * ya);
                if (t2 >= 0 && t2 <= 1) {
                    const y = this.pointOnCurve(t2).y;
                    minY = Math.min(minY, y);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        bounds[0] = minX;
        bounds[1] = minY;
        bounds[2] = maxX;
        bounds[3] = maxY;
    }

    /**
     * Returns two Cubics, created by splitting this curve at the given distance of `t` between the
     * original starting and ending anchor points.
     * @param {number} t
     * @returns {[Cubic, Cubic]}
     */
    split(t) {
        const u = 1 - t;
        const p = this.pointOnCurve(t);
        const c1 = createCubic(
            this.anchor0X, this.anchor0Y,
            this.anchor0X * u + this.control0X * t, this.anchor0Y * u + this.control0Y * t,
            this.anchor0X * u * u + this.control0X * 2 * u * t + this.control1X * t * t,
            this.anchor0Y * u * u + this.control0Y * 2 * u * t + this.control1Y * t * t,
            p.x, p.y
        );
        const c2 = createCubic(
            p.x, p.y,
            this.control0X * u * u + this.control1X * 2 * u * t + this.anchor1X * t * t,
            this.control0Y * u * u + this.control1Y * 2 * u * t + this.anchor1Y * t * t,
            this.control1X * u + this.anchor1X * t, this.control1Y * u + this.anchor1Y * t,
            this.anchor1X, this.anchor1Y
        );
        return [c1, c2];
    }

    /** Utility function to reverse the control/anchor points for this curve. */
    reverse() {
        return createCubic(
            this.anchor1X, this.anchor1Y, this.control1X, this.control1Y,
            this.control0X, this.control0Y, this.anchor0X, this.anchor0Y
        );
    }

    /** Adds two Cubic objects together, returning a new Cubic. */
    plus(o) { return new Cubic(this.points.map((p, i) => p + o.points[i])); }
    /** Multiplies a Cubic by a scalar value, returning a new Cubic. */
    times(x) { return new Cubic(this.points.map(p => p * x)); }
    /** Divides a Cubic by a scalar value, returning a new Cubic. */
    div(x) { return this.times(1 / x); }

    toString() {
        return `anchor0: (${this.anchor0X}, ${this.anchor0Y}) control0: (${this.control0X}, ${this.control0Y}), ` +
               `control1: (${this.control1X}, ${this.control1Y}), anchor1: (${this.anchor1X}, ${this.anchor1Y})`;
    }

    equals(other) {
        if (this === other) return true;
        if (!(other instanceof Cubic)) return false;
        for (let i = 0; i < this.points.length; i++) {
            if (this.points[i] !== other.points[i]) return false;
        }
        return true;
    }

    /**
     * Transforms the points in this `Cubic` with the given `PointTransformer` and returns a new `Cubic`.
     * @param {PointTransformer} f The `PointTransformer` used to transform this `Cubic`.
     * @returns {Cubic}
     */
    transformed(f) {
        const newCubic = new MutableCubic();
        newCubic.points.set(this.points);
        newCubic.transform(f);
        return new Cubic(newCubic.points);
    }

    /**
     * Generates a bezier curve that is a straight line between the given anchor points.
     * @param {number} x0
     * @param {number} y0
     * @param {number} x1
     * @param {number} y1
     * @returns {Cubic}
     */
    static straightLine(x0, y0, x1, y1) {
        return createCubic(
            x0, y0,
            interpolate(x0, x1, 1 / 3), interpolate(y0, y1, 1 / 3),
            interpolate(x0, x1, 2 / 3), interpolate(y0, y1, 2 / 3),
            x1, y1
        );
    }

    /**
     * Generates a bezier curve that approximates a circular arc.
     * @param {number} centerX
     * @param {number} centerY
     * @param {number} x0
     * @param {number} y0
     * @param {number} x1
     * @param {number} y1
     * @returns {Cubic}
     */
    static circularArc(centerX, centerY, x0, y0, x1, y1) {
        const p0d = directionVector(x0 - centerX, y0 - centerY);
        const p1d = directionVector(x1 - centerX, y1 - centerY);
        const rotatedP0 = p0d.rotate90();
        const rotatedP1 = p1d.rotate90();
        const clockwise = rotatedP0.dotProduct(x1 - centerX, y1 - centerY) >= 0;
        const cosa = p0d.dotProduct(p1d);
        if (cosa > 0.999) return Cubic.straightLine(x0, y0, x1, y1);

        const k = math_distance(x0 - centerX, y0 - centerY) * 4 / 3 *
                  (Math.sqrt(2 * (1 - cosa)) - Math.sqrt(1 - cosa * cosa)) / (1 - cosa) *
                  (clockwise ? 1 : -1);

        return createCubic(
            x0, y0,
            x0 + rotatedP0.x * k, y0 + rotatedP0.y * k,
            x1 - rotatedP1.x * k, y1 - rotatedP1.y * k,
            x1, y1
        );
    }

    /**
     * Generates an empty Cubic defined at (x0, y0).
     * @param {number} x0
     * @param {number} y0
     * @returns {Cubic}
     * @internal
     */
    static empty(x0, y0) {
        return createCubic(x0, y0, x0, y0, x0, y0, x0, y0);
    }
}

/**
 * Creates a Cubic that holds the anchor and control point data for a single Bézier curve.
 * The returned instance is immutable.
 *
 * @param {number} anchor0X
 * @param {number} anchor0Y
 * @param {number} control0X
 * @param {number} control0Y
 * @param {number} control1X
 * @param {number} control1Y
 * @param {number} anchor1X
 * @param {number} anchor1Y
 * @returns {Cubic}
 */
export function createCubic(
    anchor0X, anchor0Y, control0X, control0Y,
    control1X, control1Y, anchor1X, anchor1Y
) {
    return new Cubic(new Float32Array([
        anchor0X, anchor0Y, control0X, control0Y,
        control1X, control1Y, anchor1X, anchor1Y
    ]));
}

/**
 * This is a Mutable version of `Cubic`, used mostly for performance-critical paths to avoid
 * creating new `Cubic` instances.
 *
 * This is used in Morph.forEachCubic, reusing a `MutableCubic` instance to avoid creating new `Cubic`s.
 */
export class MutableCubic extends Cubic {
    /** @private */
    transformOnePoint(f, ix) {
        const result = f.transform(this.points[ix], this.points[ix + 1]);
        this.points[ix] = result.first;
        this.points[ix + 1] = result.second;
    }

    /**
     * @param {PointTransformer} f
     */
    transform(f) {
        this.transformOnePoint(f, 0);
        this.transformOnePoint(f, 2);
        this.transformOnePoint(f, 4);
        this.transformOnePoint(f, 6);
    }

    /**
     * @param {Cubic} c1
     * @param {Cubic} c2
     * @param {number} progress
     */
    interpolate(c1, c2, progress) {
        for (let i = 0; i < 8; i++) {
            this.points[i] = interpolate(c1.points[i], c2.points[i], progress);
        }
    }
}
