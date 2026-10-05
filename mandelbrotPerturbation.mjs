/**
 * @author Bert Baron
 */
import {WorkerContext, smoothen} from "./workerContext.mjs";
import {BlaTable} from "./bla.mjs";

export class MandelbrotPerturbation {
    /**
     * @param {WorkerContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx
        this.paramHash = null
        this.jobId = null
        this.referencePoints = []
        this.useBla = true
    }

    async process(task){
        this.max_iter = task.maxIter
        const w = task.w
        const h = task.h

        const values = new Int32Array(w * h)
        const smooth = task.smooth ? new Uint8ClampedArray(w * h) : null
        const start = performance.now()
        this.calculate(values, smooth, w, h, task.skipTopLeft, task)
        const end = performance.now()

        return {
            type: 'answer',
            task: task,
            values: values,
            smooth: smooth,
            stats: {
                time: end - start,
                timeHighPrecision: this.ctx.stats.timeSpendInHighPrecision,
                highPrecisionCalculations: this.ctx.stats.numberOfHighPrecisionPoints,
                lowPrecisionMisses: this.ctx.stats.numberOfLowPrecisionMisses,
            }
        }
    }

    calculate(values, smooth, w, h, skipTopLeft, task) {
        const stats = this.ctx.stats
        const scale = task.precision
        const scaleFactor = Math.pow(2, Number(scale))
        const bigScale = BigInt(scale)
        const rmin = task.frameTopLeft[0]
        const rmax = task.frameBottomRight[0]
        const imin = task.frameTopLeft[1]
        const imax = task.frameBottomRight[1]

        // Size in the complex plane
        const cWidth = Number(rmax.subtract(rmin).bigInt) / scaleFactor
        const cHeight = Number(imax.subtract(imin).bigInt) / scaleFactor
        const refr = rmin.bigInt
        const refi = imin.bigInt

        const bailout = smooth ? 128 : 4
        const bigBailout = BigInt(bailout) << bigScale

        this.updateCache(task, cWidth, cHeight, scaleFactor)

        if (this.referencePoints.length === 0) {
            const x = Math.trunc(w / 2)
            const y = Math.trunc(h / 2)
            const dr = (task.xOffset + x) / task.frameWidth * cWidth
            const di = (task.yOffset + y) / task.frameHeight * cHeight
            this.referencePoints.push(this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bigBailout))
            if (this.ctx.shouldStop()) return
        }

        // We queue reference points in LRU order, the head pointing to the least recently successfully used reference point
        let head = this.referencePoints.length - 1
        for (let y = 0; y < h; y++) {
            const di = (task.yOffset + y) / task.frameHeight * cHeight
            const skipLeft = skipTopLeft && y % 2 === 0

            for (let x = 0; x < w; x++) {
                if (skipLeft && x % 2 === 0) {
                    // skip
                } else {
                    const dr = (task.xOffset + x) / task.frameWidth * cWidth

                    let found = false
                    const offset = y * w + x
                    const start = performance.now()

                    let refIndex = head
                    for (let ignored of this.referencePoints) {
                        let referencePoint = this.referencePoints[refIndex]
                        const refDr = referencePoint[0][0]
                        const refDi = referencePoint[0][1]
                        const zs = referencePoint[3]
                        const dcr = dr - refDr
                        const dci = di - refDi
                        let bla = null
                        if (this.useBla) {
                            bla = referencePoint[4] ??= this.createBlaTable(refDr, refDi, zs, cWidth, cHeight)
                            if (dcr * dcr + dci * dci > bla.deltaMax * bla.deltaMax) bla = null
                        }

                        const [iter, zq] = this.mandlebrot_perturbation(dcr, dci, this.max_iter, bailout, zs, bla)
                        if (iter >= 0) {
                            values[offset] = smoothen(smooth, offset, iter, zq)
                            found = true
                            stats.numberOfLowPrecisionPoints++
                            if (refIndex < head) {
                                head--
                                this.referencePoints[refIndex] = this.referencePoints[head]
                                this.referencePoints[head] = referencePoint
                            } else if (refIndex > head) {
                                for (let i = refIndex; i > head; i--) {
                                    this.referencePoints[i] = this.referencePoints[i - 1]
                                }
                                this.referencePoints[head] = referencePoint
                            }
                            break
                        }
                        stats.numberOfLowPrecisionMisses++
                        refIndex = (refIndex + 1) % this.referencePoints.length
                    }

                    const end = performance.now()
                    this.ctx.stats.timeSpendInLowPrecision += end - start
                    if (!found) {
                        const newRef = this.calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bigBailout)
                        values[offset] = smoothen(smooth, offset, newRef[1], Number(newRef[2]) / scaleFactor)
                        this.referencePoints.unshift(newRef)
                        this.referencePoints[0] = this.referencePoints[head]
                        this.referencePoints[head] = newRef
                        if (this.ctx.shouldStop()) return
                    }
                }
            }
            if (this.ctx.shouldStop()) return
        }
    }

    updateCache(task, cWidth, cHeight, scaleFactor) {
        if (task.jobId !== this.jobId) {
            this.jobId = task.jobId
            if (this.paramHash !== task.paramHash || this.referencePoints.length === 0 || task.resetCaches) {
                this.paramHash = task.paramHash
                this.referencePoints = []
            } else {
                // Keep reference points that are within the total frame when job parameters did not change
                const oldReferencePoints = this.referencePoints
                this.referencePoints = []
                const oldPrecision = this.precision
                const newPrecision = task.precision
                if (newPrecision === oldPrecision) {
                    const deltar = Number(task.frameTopLeft[0].subtract(this.topLeft[0]).bigInt) / scaleFactor
                    const deltai = Number(task.frameTopLeft[1].subtract(this.topLeft[1]).bigInt) / scaleFactor
                    for (let referencePoint of oldReferencePoints) {
                        const dr = referencePoint[0][0] - deltar
                        const di = referencePoint[0][1] - deltai
                        if (dr < cWidth && di < cHeight) {
                            referencePoint[0] = [dr, di]
                            this.referencePoints.push(referencePoint)
                        }
                    }
                }
            }
            this.precision = task.precision
            this.topLeft = task.frameTopLeft
        }
    }

    /**
     * @param {number} refDr
     * @param {number} refDi
     * @param {[number, number, number][]} zs
     * @param {number} cWidth
     * @param {number} cHeight
     * @returns {BlaTable}
     */
    createBlaTable(refDr, refDi, zs, cWidth, cHeight) {
        // Largest |δ| of any pixel in the frame relative to this reference point
        const deltaMax = Math.hypot(Math.max(refDr, cWidth - refDr), Math.max(refDi, cHeight - refDi))
        // Never skip past the iteration where the reference escapes or past max_iter
        const limit = Math.min(zs.length - 2, this.max_iter)
        return new BlaTable(zs, limit, deltaMax)
    }

    /**
     * @param {number} dcr
     * @param {number} dci
     * @param {number} max_iter
     * @param {number} bailout
     * @param {[number, number, number][]} zs
     * @param {BlaTable|null} bla
     * @returns {(number|number)[]|number[]}
     */
    mandlebrot_perturbation(dcr, dci, max_iter, bailout, zs, bla) {
        const levels = bla === null ? null : bla.levels

        // ε₀ = δ
        let ezr = dcr
        let ezi = dci

        let iter = -1
        let zzq = 0
        while (zzq <= bailout) {
            if (iter++ === max_iter) {
                return [2, 0]
            }
            if (iter >= zs.length) {
                return [-1, zzq]
            }

            // Skip runs of iterations that can be approximated linearly: εₙ₊ₗ = A·εₙ + B·δ. A run of 2^j steps can only
            // start at a multiple of 2^j, and is never valid when the run of 2^(j-1) steps at the same start isn't. So we
            // check the shortest run first (a single check when it fails) and climb to longer runs from there.
            if (levels !== null && (iter & 1) === 0) {
                const level1 = levels[0]
                let eq = ezr * ezr + ezi * ezi
                while ((iter >> 1) < level1.r2.length && eq < level1.r2[iter >> 1]) {
                    const maxLevel = iter === 0 ? levels.length : Math.min(31 - Math.clz32(iter & -iter), levels.length)
                    let j = 1
                    while (j < maxLevel) {
                        const i = iter >> (j + 1)
                        const r2 = levels[j].r2
                        if (i < r2.length && eq < r2[i]) j++
                        else break
                    }
                    const level = levels[j - 1]
                    const i = iter >> j
                    const ar = level.ar[i], ai = level.ai[i], br = level.br[i], bi = level.bi[i]
                    const _ezr = ar * ezr - ai * ezi + br * dcr - bi * dci
                    ezi = ar * ezi + ai * ezr + br * dci + bi * dcr
                    ezr = _ezr
                    eq = ezr * ezr + ezi * ezi
                    // stays even, so the next run may start right where this one ended
                    iter += 1 << j
                }
            }

            // Zₙ
            const _zsvalues = zs[iter]
            const zr = _zsvalues[0]
            const zi = _zsvalues[1]
            const zqErrorBound = _zsvalues[2]

            // Z'ₙ = Zₙ + εₙ
            const zzr = zr + ezr
            const zzi = zi + ezi
            zzq = zzr * zzr + zzi * zzi
            if (zzq < zqErrorBound) {
                return [-1, 0]
            }

            // εₙ₊₁ = 2·zₙ·εₙ + εₙ² + δ = (2·zₙ + εₙ)·εₙ + δ
            const zr_ezr_2 = zr + zzr
            const zi_ezi_2 = zi + zzi
            const _ezr = zr_ezr_2 * ezr - zi_ezi_2 * ezi
            const _ezi = zr_ezr_2 * ezi + zi_ezi_2 * ezr
            ezr = _ezr + dcr
            ezi = _ezi + dci
        }
        return [iter + 4, zzq]
    }

    /**
     * @param {BigInt} refr
     * @param {BigInt} refi
     * @param {number} dr
     * @param {number} di
     * @param {BigInt} bigScale
     * @param {number} scaleFactor
     * @param {BigInt} bailout
     * @returns {[[number, number], number, BigInt, [number, number, number][]]} [rr, ri], iter, zq, sequence where sequence is a list of [zr, zi, errorbound] tuples
     */
    calculate_reference(refr, refi, dr, di, bigScale, scaleFactor, bailout) {
        const start = performance.now()
        const rr = refr + BigInt(Math.round(dr * scaleFactor))
        const ri = refi + BigInt(Math.round(di * scaleFactor))
        const [iter, zq, seq] = this.mandelbrot_high_precision(rr, ri, this.max_iter, bailout, bigScale)
        const zs = seq.map(([zr, zi]) => {
            let z_real = Number(zr) / scaleFactor;
            let z_imag = Number(zi) / scaleFactor;
            return [z_real, z_imag, (z_real * z_real + z_imag * z_imag) * 0.000001];
        })
        const end = performance.now()
        this.ctx.stats.timeSpendInHighPrecision += end - start
        this.ctx.stats.numberOfHighPrecisionPoints++
        return [[dr, di], iter, zq, zs]
    }

    /**
     * @param {BigInt} re
     * @param {BigInt} im
     * @param {number} max_iter
     * @param {BigInt} bailout
     * @param {BigInt} scale
     * @returns {[number, BigInt, [BigInt, BigInt][]]} [iterations, zq, sequence] where sequence is a list of [zr, zi] points
     */
    mandelbrot_high_precision(re, im, max_iter, bailout, scale) {
        const scale_1 = scale - 1n
        let zr = 0n
        let zi = 0n
        let iter = -1
        let zrq = 0n
        let ziq = 0n
        let zq = 0n
        const seq = []
        while (zq <= bailout) {
            if (iter++ === max_iter) {
                return [2, 0n, seq]
            }
            zi = (zr * zi >> scale_1) + im
            zr = zrq - ziq + re
            seq.push([zr, zi])
            zrq = (zr * zr) >> scale
            ziq = (zi * zi) >> scale
            zq = zrq + ziq
        }
        zi = (zr * zi >> scale_1) + im
        zr = zrq - ziq + re
        seq.push([zr, zi])
        return [iter + 4, zq, seq]
    }
}
