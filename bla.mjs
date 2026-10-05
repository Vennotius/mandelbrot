/**
 * Bilinear approximation (BLA) for perturbation rendering.
 *
 * Perturbation iterates εₙ₊₁ = 2·Zₙ·εₙ + εₙ² + δ. As long as εₙ is small compared to Zₙ the εₙ² term is negligible
 * and a single step is linear: εₙ₊₁ ≈ A·εₙ + B·δ with A = 2·Zₙ and B = 1. Linear steps compose, so a run of l steps
 * starting at iteration m is again of the form εₘ₊ₗ ≈ A·εₘ + B·δ. Such a run is valid as long as |εₘ| < R.
 *
 * Runs are stored in a binary tree: level j holds runs of 2^j steps starting at multiples of 2^j. A pixel at iteration m
 * looks for the longest valid run starting at m and skips straight to m + 2^j.
 *
 * See https://mathr.co.uk/web/deep-zoom.html#bilinear-approximation
 */

// Maximum relative size of the dropped εₙ² term for a single step: |εₙ| < ETA·|Zₙ|
const ETA = 2 ** -40

export class BlaTable {
    /**
     * @param {[number, number][]} zs reference orbit, zs[n] being the reference value paired with εₙ
     * @param {number} limit last iteration a run may end at
     * @param {number} deltaMax upper bound of |δ| for the pixels that will use this table
     */
    constructor(zs, limit, deltaMax) {
        this.deltaMax = deltaMax
        this.levels = []

        // Level 1 is built directly from the orbit: two single steps merged. Level 0 (single steps) is not stored as
        // skipping one step saves nothing.
        let count = Math.floor(limit / 2)
        if (count < 1) return
        let level = newLevel(count)
        for (let i = 0; i < count; i++) {
            const n = 2 * i
            const xAr = 2 * zs[n][0], xAi = 2 * zs[n][1], xR = ETA * Math.hypot(zs[n][0], zs[n][1])
            const yAr = 2 * zs[n + 1][0], yAi = 2 * zs[n + 1][1], yR = ETA * Math.hypot(zs[n + 1][0], zs[n + 1][1])
            merge(level, i, xAr, xAi, 1, 0, xR, yAr, yAi, 1, 0, yR, deltaMax)
        }
        this.levels.push(level)

        while (count > 1) {
            const prev = level
            count = Math.floor(count / 2)
            level = newLevel(count)
            for (let i = 0; i < count; i++) {
                const x = 2 * i, y = 2 * i + 1
                merge(level, i,
                    prev.ar[x], prev.ai[x], prev.br[x], prev.bi[x], Math.sqrt(prev.r2[x]),
                    prev.ar[y], prev.ai[y], prev.br[y], prev.bi[y], Math.sqrt(prev.r2[y]),
                    deltaMax)
            }
            this.levels.push(level)
        }
    }
}

function newLevel(count) {
    return {
        ar: new Float64Array(count),
        ai: new Float64Array(count),
        br: new Float64Array(count),
        bi: new Float64Array(count),
        // validity radius R, stored squared so lookups can compare against |ε|² directly
        r2: new Float64Array(count),
    }
}

// Run x followed by run y: ε' = Ay·(Ax·ε + Bx·δ) + By·δ, valid when |ε| < Rx and |Ax·ε + Bx·δ| < Ry
function merge(level, i, xAr, xAi, xBr, xBi, xR, yAr, yAi, yBr, yBi, yR, deltaMax) {
    level.ar[i] = yAr * xAr - yAi * xAi
    level.ai[i] = yAr * xAi + yAi * xAr
    level.br[i] = yAr * xBr - yAi * xBi + yBr
    level.bi[i] = yAr * xBi + yAi * xBr + yBi
    const r = Math.max(0, Math.min(xR, (yR - Math.hypot(xBr, xBi) * deltaMax) / Math.hypot(xAr, xAi)))
    // NaN (overflow, 0/0) must never validate a run
    level.r2[i] = r >= 0 ? r * r : 0
}
