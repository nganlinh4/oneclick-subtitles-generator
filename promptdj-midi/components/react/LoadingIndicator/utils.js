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

/**
 * A simple class representing a 2D point.
 */
export class Point {
    /**
     * @param {number} x
     * @param {number} y
     */
    constructor(x, y) {
        this.x = x;
        this.y = y;
    }

    /** Rotates the point 90 degrees counter-clockwise around the origin. */
    rotate90() {
        return new Point(-this.y, this.x);
    }

    /** Calculates the dot product with another point or vector. */
    dotProduct(otherX, otherY) {
        if (otherX instanceof Point) {
            return this.x * otherX.x + this.y * otherX.y;
        }
        return this.x * otherX + this.y * otherY;
    }

    /** Calculates the Euclidean distance from the origin (0, 0). */
    getDistance() {
        return Math.sqrt(this.x * this.x + this.y * this.y);
    }

    /** Adds another point to this one, returning a new Point. */
    plus(other) {
        return new Point(this.x + other.x, this.y + other.y);
    }

    /** Subtracts another point from this one, returning a new Point. */
    minus(other) {
        return new Point(this.x - other.x, this.y - other.y);
    }

    /** Multiplies the point's coordinates by a scalar, returning a new Point. */
    times(scalar) {
        return new Point(this.x * scalar, this.y * scalar);
    }

    /**
     * Determines if the vector from the origin to `other` is clockwise relative to the
     * vector from the origin to `this`.
     * This is equivalent to checking the sign of the Z component of the 2D cross product.
     * @param {Point} other
     * @returns {boolean}
     */
    clockwise(other) {
        return this.x * other.y - this.y * other.x >= 0;
    }

    // Aliases for compatibility with roundedPolygon.js
    add(other) { return this.plus(other); }
    subtract(other) { return this.minus(other); }
    scale(factor) { return this.times(factor); }

    /** Returns the direction vector (unit vector) from origin to this point */
    getDirection() {
        const d = this.getDistance();
        return d > DistanceEpsilon ? this.scale(1 / d) : new Point(0, 0);
    }

    /** Transform this point using a transformation function */
    transformed(f) {
        const result = f(this.x, this.y);
        return new Point(result.x, result.y);
    }

    /** Check if this point equals another point within epsilon tolerance */
    equals(other) {
        if (!other) return false;
        return Math.abs(this.x - other.x) < DistanceEpsilon && Math.abs(this.y - other.y) < DistanceEpsilon;
    }
}

/**
 * Calculates the Euclidean distance of a point (x, y) from the origin.
 * @internal
 */
export function distance(x, y) {
    return Math.sqrt(x * x + y * y);
}

/**
 * Calculates the squared Euclidean distance of a point (x, y) from the origin.
 * @internal
 */
export function distanceSquared(x, y) {
    return x * x + y * y;
}

/**
 * Returns a unit vector representing the direction to the point (x, y) from (0, 0).
 * @internal
 * @throws {Error} if the distance is zero.
 */
export function directionVector(x, y) {
    if (arguments.length === 2) {
        const d = distance(x, y);
        if (d <= 0) {
            throw new Error("Required distance greater than zero");
        }
        return new Point(x / d, y / d);
    }
    // Overload for angle in radians
    const angleRadians = x;
    return new Point(Math.cos(angleRadians), Math.sin(angleRadians));
}

/** The origin point (0, 0). @internal */
export const Zero = new Point(0, 0);

/**
 * Converts polar coordinates to Cartesian coordinates.
 * @internal
 */
export function radialToCartesian(radius, angleRadians, center = Zero) {
    return directionVector(angleRadians).times(radius).plus(center);
}

/**
 * Epsilon value used for comparing distances, to account for floating-point inaccuracies.
 * @internal
 */
export const DistanceEpsilon = 1e-4;

/**
 * Epsilon value used for comparing angles.
 * @internal
 */
export const AngleEpsilon = 1e-6;

/**
 * A more relaxed epsilon for operations where human perception allows for higher tolerances,
 * such as checking for collinearity.
 * @internal
 */
export const RelaxedDistanceEpsilon = 5e-3;

/** The value of PI as a float. @internal */
export const FloatPi = Math.PI;

/** The value of 2 * PI as a float. @internal */
export const TwoPi = 2 * Math.PI;

/**
 * Squares a number.
 * @internal
 */
export function square(x) {
    return x * x;
}

/**
 * Linearly interpolates between `start` and `stop` with `fraction`.
 * @internal
 */
export function interpolate(start, stop, fraction) {
    return (1 - fraction) * start + fraction * stop;
}

/**
 * Similar to `num % mod`, but ensures the result is always positive.
 * For example: `4 % 3` -> `1`, `-4 % 3` -> `-1`, but `positiveModulo(-4, 3)` -> `2`.
 * @internal
 */
export function positiveModulo(num, mod) {
    return ((num % mod) + mod) % mod;
}

/**
 * Checks if point C is on the line defined by points A and B, within a given tolerance.
 * @internal
 */
export function collinearIsh(aX, aY, bX, bY, cX, cY, tolerance = DistanceEpsilon) {
    // The dot product of a perpendicular angle is 0. By rotating one of the vectors,
    // we save the calculations to convert the dot product to degrees afterwards.
    const ab = new Point(bX - aX, bY - aY).rotate90();
    const ac = new Point(cX - aX, cY - aY);
    const dotProduct = Math.abs(ab.dotProduct(ac));
    const relativeTolerance = tolerance * ab.getDistance() * ac.getDistance();

    return dotProduct < tolerance || dotProduct < relativeTolerance;
}

/**
 * Approximates whether a corner at a vertex is concave or convex.
 * @internal
 */
export function convex(previous, current, next) {
    // TODO: b/369320447 - This is a fast, but not reliable calculation.
    return current.minus(previous).clockwise(next.minus(current));
}

/**
 * A function to be minimized by `findMinimum`.
 * @callback FindMinimumFunction
 * @param {number} value - The input value.
 * @returns {number} The result of the function at that value.
 */

/**
 * Performs a ternary search in the range [v0..v1] to find the parameter that minimizes the given function.
 * @internal
 * @param {number} v0 - The start of the search range.
 * @param {number} v1 - The end of the search range.
 * @param {number} [tolerance=1e-3] - The desired precision. The search stops when the range is smaller than this.
 * @param {FindMinimumFunction} f - The function to minimize.
 * @returns {number} The value in the range that minimizes the function.
 */
export function findMinimum(v0, v1, tolerance = 1e-3, f) {
    let a = v0;
    let b = v1;
    while (b - a > tolerance) {
        const c1 = (2 * a + b) / 3;
        const c2 = (2 * b + a) / 3;
        if (f(c1) < f(c2)) {
            b = c2;
        } else {
            a = c1;
        }
    }
    return (a + b) / 2;
}

/** @internal */
export const DEBUG = false;

/**
 * Logs a message to the console if DEBUG is true.
 * The message is only generated if it will be logged.
 * @internal
 * @param {string} tag
 * @param {() => string} messageFactory
 */
export function debugLog(tag, messageFactory) {
    if (DEBUG) {
        console.log(`${tag}: ${messageFactory()}`);
    }
}
