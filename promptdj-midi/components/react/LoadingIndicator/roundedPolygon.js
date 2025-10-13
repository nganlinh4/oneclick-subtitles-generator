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
    Cubic,
    MutableCubic
} from "./cubic.js";
import {
    Point,
    distance,
    distanceSquared,
    square,
    FloatPi,
    radialToCartesian,
    convex,
    debugLog,
    DistanceEpsilon,
    Zero,
    directionVector
} from "./utils.js";
// CornerRounding functionality will be implemented inline
const CornerRounding = { Unrounded: 0 };

/**
 * A feature represents a segment of the polygon's outline, which can be either a
 * rounded corner or a straight edge connecting two corners.
 * @abstract
 */
export class Feature {
    /** @type {Cubic[]} */
    cubics;
    /** @type {boolean} */
    isCorner = false;

    /** @param {Cubic[]} cubics */
    constructor(cubics) {
        this.cubics = cubics;
    }

    /**
     * @param {PointTransformer} f
     * @returns {Feature}
     */
    transformed(f) {
        throw new Error("Not implemented");
    }
}

/** A feature representing a rounded corner. */
Feature.Corner = class Corner extends Feature {
    /** @type {boolean} */
    convex;
    isCorner = true;

    /**
     * @param {Cubic[]} cubics
     * @param {boolean} convex
     */
    constructor(cubics, convex) {
        super(cubics);
        this.convex = convex;
    }

    transformed(f) {
        return new Feature.Corner(this.cubics.map(c => c.transformed(f)), this.convex);
    }
};

/** A feature representing a straight edge. */
Feature.Edge = class Edge extends Feature {
    transformed(f) {
        return new Feature.Edge(this.cubics.map(c => c.transformed(f)));
    }
};


/**
 * The RoundedPolygon class allows simple construction of polygonal shapes with optional rounding at
 * the vertices. Polygons can be constructed with either the number of vertices desired or an
 * ordered list of vertices.
 */
export class RoundedPolygon {
    /** @type {Feature[]} */
    features;
    /** @type {Point} */
    center;
    /** @type {Cubic[]} */
    cubics;

    get centerX() { return this.center.x; }
    get centerY() { return this.center.y; }

    /**
     * This constructor handles multiple signatures to create a RoundedPolygon.
     * 1. `new RoundedPolygon(numVertices, radius, centerX, centerY, rounding, perVertexRounding)`
     * 2. `new RoundedPolygon(vertices, rounding, perVertexRounding, centerX, centerY)`
     * 3. `new RoundedPolygon(features, centerX, centerY)` - Internal use mostly
     * 4. `new RoundedPolygon(sourcePolygon)` - Copy constructor
     *
     * @param {number | Float32Array | number[] | Feature[] | RoundedPolygon} arg1
     * @param {...any} args
     */
    constructor(arg1, ...args) {
        let features, center;

        if (arg1 instanceof RoundedPolygon) {
            // Copy constructor: new RoundedPolygon(source)
            features = arg1.features;
            center = arg1.center;
        } else if (typeof arg1 === 'number') {
            // Vertices from number: new RoundedPolygon(numVertices, ...)
            const [
                radius = 1,
                centerX = 0,
                centerY = 0,
                rounding = 0,
                perVertexRounding = null
            ] = args;
            const vertices = verticesFromNumVerts(arg1, radius, centerX, centerY);
            ({ features, center } =
                computeFeaturesFromVertices(vertices, rounding, perVertexRounding, centerX, centerY));
        } else if (Array.isArray(arg1) && (arg1.length === 0 || arg1[0] instanceof Feature)) {
            // From features: new RoundedPolygon(features, centerX, centerY)
            const [centerX = NaN, centerY = NaN] = args;
            features = arg1;

            if (features.length < 2 && features.length > 0) throw new Error("Polygons must have at least 2 features");

            const vertices = [];
            for (const feature of features) {
                for (const cubic of feature.cubics) {
                    vertices.push(cubic.anchor0X, cubic.anchor0Y);
                }
            }
            const calculatedCenter = calculateCenter(vertices);
            const cX = !isNaN(centerX) ? centerX : calculatedCenter.x;
            const cY = !isNaN(centerY) ? centerY : calculatedCenter.y;
            center = new Point(cX, cY);
        } else if (arg1 instanceof Float32Array || Array.isArray(arg1)) {
            // From vertices array: new RoundedPolygon(vertices, ...)
            const [
                rounding = 0,
                perVertexRounding = null,
                centerX = NaN,
                centerY = NaN
            ] = args;
            ({ features, center } =
                computeFeaturesFromVertices(arg1, rounding, perVertexRounding, centerX, centerY));
        } else {
            throw new Error("Invalid arguments for RoundedPolygon constructor");
        }

        this.features = features;
        this.center = center;
        this.cubics = this.#flattenCubics(features, center);
        this.#validateContinuity();
    }

    #flattenCubics(features, center) {
        const cubics = [];
        if (features.length === 0) {
            // Empty / 0-sized polygon.
            cubics.push(new Cubic(new Float32Array([
                center.x, center.y, center.x, center.y,
                center.x, center.y, center.x, center.y
            ])));
            return cubics;
        }

        let firstCubic = null;
        let lastCubic = null;

        for (const feature of features) {
            for (const cubic of feature.cubics) {
                if (!cubic.zeroLength()) {
                    if (lastCubic) cubics.push(lastCubic);
                    lastCubic = cubic;
                    if (!firstCubic) firstCubic = cubic;
                } else if (lastCubic) {
                    const newPoints = lastCubic.points.slice();
                    newPoints[6] = cubic.anchor1X;
                    newPoints[7] = cubic.anchor1Y;
                    lastCubic = new Cubic(newPoints);
                }
            }
        }

        if (lastCubic && firstCubic) {
            cubics.push(new Cubic(new Float32Array([
                lastCubic.anchor0X, lastCubic.anchor0Y,
                lastCubic.control0X, lastCubic.control0Y,
                lastCubic.control1X, lastCubic.control1Y,
                firstCubic.anchor0X, firstCubic.anchor0Y,
            ])));
        }
        return cubics;
    }

    #validateContinuity() {
        if (this.cubics.length <= 1) return;
        let prevCubic = this.cubics[this.cubics.length - 1];
        for (let index = 0; index < this.cubics.length; index++) {
            const cubic = this.cubics[index];
            if (Math.abs(cubic.anchor0X - prevCubic.anchor1X) > DistanceEpsilon ||
                Math.abs(cubic.anchor0Y - prevCubic.anchor1Y) > DistanceEpsilon) {
                throw new Error(
                    "RoundedPolygon must be contiguous, with the anchor points of all curves " +
                    "matching the anchor points of the preceding and succeeding cubics"
                );
            }
            prevCubic = cubic;
        }
    }

    transformed(f) {
        const newCenter = f.transform(this.center.x, this.center.y);
        const newFeatures = this.features.map(feat => feat.transformed(f));
        // Use internal constructor signature
        return new RoundedPolygon(newFeatures, newCenter.first, newCenter.second);
    }

    normalized() {
        const bounds = this.calculateBounds();
        const width = bounds[2] - bounds[0];
        const height = bounds[3] - bounds[1];
        const side = Math.max(width, height);
        if (side === 0) return this;
        const offsetX = (side - width) / 2 - bounds[0];
        const offsetY = (side - height) / 2 - bounds[1];
        return this.transformed((x, y) => ({
            first: (x + offsetX) / side,
            second: (y + offsetY) / side
        }));
    }

    calculateMaxBounds(bounds = new Float32Array(4)) {
        if (bounds.length < 4) throw new Error("Required bounds size of 4");
        let maxDistSquared = 0;
        for (const cubic of this.cubics) {
            const anchorDistance = distanceSquared(cubic.anchor0X - this.centerX, cubic.anchor0Y - this.centerY);
            const middlePoint = cubic.pointOnCurve(0.5);
            const middleDistance = distanceSquared(middlePoint.x - this.centerX, middlePoint.y - this.centerY);
            maxDistSquared = Math.max(maxDistSquared, anchorDistance, middleDistance);
        }
        const dist = Math.sqrt(maxDistSquared);
        bounds[0] = this.centerX - dist;
        bounds[1] = this.centerY - dist;
        bounds[2] = this.centerX + dist;
        bounds[3] = this.centerY + dist;
        return bounds;
    }

    calculateBounds(bounds = new Float32Array(4), approximate = true) {
        if (bounds.length < 4) throw new Error("Required bounds size of 4");
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const tempBounds = new Float32Array(4);
        for (const cubic of this.cubics) {
            cubic.calculateBounds(tempBounds, approximate);
            minX = Math.min(minX, tempBounds[0]);
            minY = Math.min(minY, tempBounds[1]);
            maxX = Math.max(maxX, tempBounds[2]);
            maxY = Math.max(maxY, tempBounds[3]);
        }
        bounds[0] = minX;
        bounds[1] = minY;
        bounds[2] = maxX;
        bounds[3] = maxY;
        return bounds;
    }

    equals(other) {
        if (this === other) return true;
        if (!(other instanceof RoundedPolygon)) return false;
        if (this.features.length !== other.features.length) return false;
        // This is a deep equality check, might be slow.
        return JSON.stringify(this.features) === JSON.stringify(other.features);
    }
}

/**
 * @param {Float32Array | number[]} vertices
 * @returns {Point}
 * @internal
 */
function calculateCenter(vertices) {
    let cumulativeX = 0, cumulativeY = 0;
    for (let i = 0; i < vertices.length; i += 2) {
        cumulativeX += vertices[i];
        cumulativeY += vertices[i + 1];
    }
    const numPoints = vertices.length / 2;
    return new Point(
        numPoints > 0 ? cumulativeX / numPoints : 0,
        numPoints > 0 ? cumulativeY / numPoints : 0
    );
}

/**
 * @param {number} numVertices
 * @param {number} radius
 * @param {number} centerX
 * @param {number} centerY
 * @returns {Float32Array}
 * @private
 */
function verticesFromNumVerts(numVertices, radius, centerX, centerY) {
    const result = new Float32Array(numVertices * 2);
    const centerPoint = new Point(centerX, centerY);
    for (let i = 0; i < numVertices; i++) {
        const angle = (FloatPi / numVertices * 2 * i);
        const vertex = radialToCartesian(radius, angle).plus(centerPoint);
        result[i * 2] = vertex.x;
        result[i * 2 + 1] = vertex.y;
    }
    return result;
}

/**
 * Main logic to generate features from a list of vertices.
 * @param {Float32Array | number[]} vertices
 * @param {CornerRounding} rounding
 * @param {CornerRounding[] | null} perVertexRounding
 * @param {number} centerX
 * @param {number} centerY
 * @returns {{features: Feature[], center: Point}}
 * @private
 */
function computeFeaturesFromVertices(vertices, rounding, perVertexRounding, centerX, centerY) {
    if (vertices.length < 6) throw new Error("Polygons must have at least 3 vertices");
    if (vertices.length % 2 !== 0) throw new Error("The vertices array should have even size");
    const numVerts = vertices.length / 2;
    if (perVertexRounding && perVertexRounding.length !== numVerts) {
        throw new Error("perVertexRounding list size must match the number of vertices");
    }

    const roundedCorners = [];
    for (let i = 0; i < numVerts; i++) {
        const vtxRounding = perVertexRounding ? perVertexRounding[i] : rounding;
        const prevI = (i + numVerts - 1) % numVerts;
        const nextI = (i + 1) % numVerts;
        roundedCorners.push(
            new RoundedCorner(
                new Point(vertices[prevI * 2], vertices[prevI * 2 + 1]),
                new Point(vertices[i * 2], vertices[i * 2 + 1]),
                new Point(vertices[nextI * 2], vertices[nextI * 2 + 1]),
                vtxRounding,
            )
        );
    }

    const cutAdjusts = roundedCorners.map((rc, i) => {
        const nextRc = roundedCorners[(i + 1) % numVerts];
        const expectedRoundCut = rc.expectedRoundCut + nextRc.expectedRoundCut;
        const expectedCut = rc.expectedCut + nextRc.expectedCut;
        const sideSize = distance(
            vertices[i * 2] - vertices[((i + 1) % numVerts) * 2],
            vertices[i * 2 + 1] - vertices[((i + 1) % numVerts) * 2 + 1]
        );

        if (expectedRoundCut > sideSize) {
            return { roundRatio: sideSize / expectedRoundCut, smoothRatio: 0 };
        } else if (expectedCut > sideSize) {
            return { roundRatio: 1, smoothRatio: (sideSize - expectedRoundCut) / (expectedCut - expectedRoundCut) };
        } else {
            return { roundRatio: 1, smoothRatio: 1 };
        }
    });

    const corners = [];
    for (let i = 0; i < numVerts; i++) {
        const allowedCuts = [];
        for (const delta of [0, 1]) {
            const adjust = cutAdjusts[(i + numVerts - 1 + delta) % numVerts];
            allowedCuts.push(
                roundedCorners[i].expectedRoundCut * adjust.roundRatio +
                (roundedCorners[i].expectedCut - roundedCorners[i].expectedRoundCut) * adjust.smoothRatio
            );
        }
        corners.push(roundedCorners[i].getCubics(allowedCuts[0], allowedCuts[1]));
    }

    const tempFeatures = [];
    for (let i = 0; i < numVerts; i++) {
        const prevI = (i + numVerts - 1) % numVerts;
        const nextI = (i + 1) % numVerts;
        const currVertex = new Point(vertices[i * 2], vertices[i * 2 + 1]);
        const prevVertex = new Point(vertices[prevI * 2], vertices[prevI * 2 + 1]);
        const nextVertex = new Point(vertices[nextI * 2], vertices[nextI * 2 + 1]);
        const isConvex = convex(prevVertex, currVertex, nextVertex);

        tempFeatures.push(new Feature.Corner(corners[i], isConvex));
        const lastOfCorner = corners[i][corners[i].length - 1];
        const firstOfNextCorner = corners[(i + 1) % numVerts][0];
        tempFeatures.push(new Feature.Edge([
            Cubic.straightLine(
                lastOfCorner.anchor1X, lastOfCorner.anchor1Y,
                firstOfNextCorner.anchor0X, firstOfNextCorner.anchor0Y
            )
        ]));
    }

    const center = (isNaN(centerX) || isNaN(centerY)) ?
        calculateCenter(vertices) :
        new Point(centerX, centerY);

    return { features: tempFeatures, center };
}


// --- Private RoundedCorner helper class ---

class RoundedCorner {
    constructor(p0, p1, p2, rounding) {
        this.p0 = p0;
        this.p1 = p1;
        this.p2 = p2;
        this.rounding = rounding || 0;

        const v01 = p0.minus(p1);
        const v21 = p2.minus(p1);
        const d01 = v01.getDistance();
        const d21 = v21.getDistance();

        if (d01 > 0 && d21 > 0) {
            this.d1 = v01.times(1 / d01);
            this.d2 = v21.times(1 / d21);
            // Handle both number and object rounding
            this.cornerRadius = (typeof this.rounding === 'number') ? this.rounding : (this.rounding.radius || 0);
            this.smoothing = (typeof this.rounding === 'number') ? 0 : (this.rounding.smoothing || 0);
            this.cosAngle = this.d1.dotProduct(this.d2);
            this.sinAngle = Math.sqrt(1 - square(this.cosAngle));
            this.expectedRoundCut = (this.sinAngle > 1e-3) ?
                this.cornerRadius * (this.cosAngle + 1) / this.sinAngle : 0;
        } else {
            this.d1 = Zero; this.d2 = Zero; this.cornerRadius = 0;
            this.smoothing = 0; this.cosAngle = 0; this.sinAngle = 0;
            this.expectedRoundCut = 0;
        }
    }

    get expectedCut() {
        return (1 + this.smoothing) * this.expectedRoundCut;
    }

    getCubics(allowedCut0, allowedCut1) {
        const allowedCut = Math.min(allowedCut0, allowedCut1);
        if (this.expectedRoundCut < DistanceEpsilon || allowedCut < DistanceEpsilon || this.cornerRadius < DistanceEpsilon) {
            return [Cubic.empty(this.p1.x, this.p1.y)];
        }

        const actualRoundCut = Math.min(allowedCut, this.expectedRoundCut);
        const actualSmoothing0 = this.#calculateActualSmoothingValue(allowedCut0);
        const actualSmoothing1 = this.#calculateActualSmoothingValue(allowedCut1);
        const actualR = this.cornerRadius * actualRoundCut / this.expectedRoundCut;
        const centerDistance = Math.sqrt(square(actualR) + square(actualRoundCut));
        const center = this.p1.plus(this.d1.plus(this.d2).times(0.5).getDirection().times(centerDistance));

        const circleIntersection0 = this.p1.plus(this.d1.times(actualRoundCut));
        const circleIntersection2 = this.p1.plus(this.d2.times(actualRoundCut));

        const flanking0 = this.#computeFlankingCurve(
            actualRoundCut, actualSmoothing0, this.p1, this.p0,
            circleIntersection0, circleIntersection2, center, actualR
        );
        const flanking2 = this.#computeFlankingCurve(
            actualRoundCut, actualSmoothing1, this.p1, this.p2,
            circleIntersection2, circleIntersection0, center, actualR
        ).reverse();

        return [
            flanking0,
            Cubic.circularArc(
                center.x, center.y,
                flanking0.anchor1X, flanking0.anchor1Y,
                flanking2.anchor0X, flanking2.anchor0Y
            ),
            flanking2,
        ];
    }

    #calculateActualSmoothingValue(allowedCut) {
        if (allowedCut > this.expectedCut) {
            return this.smoothing;
        } else if (allowedCut > this.expectedRoundCut) {
            const denom = this.expectedCut - this.expectedRoundCut;
            return this.smoothing * (denom > 0 ? (allowedCut - this.expectedRoundCut) / denom : 0);
        } else {
            return 0;
        }
    }

    #computeFlankingCurve(
        actualRoundCut, actualSmoothingValue, corner, sideStart,
        circleSegmentIntersection, otherCircleSegmentIntersection,
        circleCenter, actualR
    ) {
        const sideDirection = sideStart.minus(corner).getDirection();
        const curveStart = corner.plus(sideDirection.times(actualRoundCut * (1 + actualSmoothingValue)));

        const p = circleSegmentIntersection.times(1 - actualSmoothingValue).plus(
            circleSegmentIntersection.plus(otherCircleSegmentIntersection).times(0.5 * actualSmoothingValue)
        );
        const curveEnd = circleCenter.plus(
            directionVector(p.x - circleCenter.x, p.y - circleCenter.y).times(actualR)
        );

        const circleTangent = curveEnd.minus(circleCenter).rotate90();
        const anchorEnd = lineIntersection(sideStart, sideDirection, curveEnd, circleTangent) ||
                          circleSegmentIntersection;
        const anchorStart = curveStart.plus(anchorEnd.times(2)).times(1 / 3);

        return new Cubic(new Float32Array([
            curveStart.x, curveStart.y,
            anchorStart.x, anchorStart.y,
            anchorEnd.x, anchorEnd.y,
            curveEnd.x, curveEnd.y
        ]));
    }
}

function lineIntersection(p0, d0, p1, d1) {
    const rotatedD1 = d1.rotate90();
    const den = d0.dotProduct(rotatedD1);
    if (Math.abs(den) < DistanceEpsilon) return null;
    const num = p1.minus(p0).dotProduct(rotatedD1);
    if (Math.abs(den) < DistanceEpsilon * Math.abs(num)) return null;
    const k = num / den;
    return p0.plus(d0.times(k));
}