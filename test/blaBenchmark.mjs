/**
 * Renders a few deep zooms with MandelbrotPerturbation, once without and once with bilinear approximation (BLA), and
 * compares timing and the resulting iteration counts pixel by pixel.
 *
 * Node: node test/blaBenchmark.mjs
 * Browser: import {run} from './blaBenchmark.mjs' and call run(console.log)
 */
import * as fxp from '../fxp.mjs'
import * as tasks from './testtasks.mjs'
import {WorkerContext} from '../workerContext.mjs'
import {MandelbrotPerturbation} from '../mandelbrotPerturbation.mjs'

const W = 400
const H = 300

// A few favourites from favorites.js that use the perturbation path
const FAVORITES = {
    'favourite 1e19, 14000 iter': 'eyJjZW50ZXIiOlt7ImJpZ0ludCI6Ii04Mjk1NjU2MTU4ODA2NDc1NTIxNjA4NTAiLCJzY2FsZSI6Nzl9LHsiYmlnSW50IjoiLTkwODUyODE4Mzc5NDczNjAzNTU4OTUiLCJzY2FsZSI6Nzl9XSwiem9vbSI6eyJiaWdJbnQiOiIxNDc0NTgwNzc4MzczNjU4ODE3MTQ0OTAyODMwODgxOTU1NDgwODgyMTY4NiIsInNjYWxlIjo3OX0sIm1heF9pdGVyIjoxNDAwMCwic21vb3RoIjp0cnVlLCJwYWxldHRlIjp7ImlkIjoibWFuZGVsYnJvdCIsImRlbnNpdHkiOiItNSIsInJvdGF0ZSI6Ii01MyJ9fQ==',
    'favourite 1e35, 8000 iter': 'eyJjZW50ZXIiOlt7ImJpZ0ludCI6IjEwNjYzNzcyMzE3NTcwMzYzOTAyMTgyODQwMjUxNzgzNDQ3ODUyMzYiLCJzY2FsZSI6MTMxfSx7ImJpZ0ludCI6IjEwMDYwNjAzMTMyMDI2NTgxNTQwNjQ3MjU4NTIxNjE4NDg1NTcxMzAiLCJzY2FsZSI6MTMxfV0sInpvb20iOnsiYmlnSW50IjoiNTQ0MDU5MTkxODA2NzEwODg2Mzc3ODU4MDgwNjcwNTMyNjU5NTgxODcxMDI1MTU3MDEyNTcxNDA3NTIxNjA0MDQ0MzEzMDA3MTYyIiwic2NhbGUiOjEzMX0sIm1heF9pdGVyIjo4MDAwLCJzbW9vdGgiOnRydWUsInBhbGV0dGUiOnsiaWQiOiJsYXZhIiwiZGVuc2l0eSI6Ii0yNSIsInJvdGF0ZSI6MH19',
    'favourite 1e54, 5000 iter': 'eyJjZW50ZXIiOlt7ImJpZ0ludCI6Ii00MTU5MjMxMTAxOTI0ODA2Njk4OTUxMzcxNzc3MjczOTI3OTU1MzU4MzAzNjczNDQ2MTE1Mjc4OTI1MiIsInNjYWxlIjoxOTR9LHsiYmlnSW50IjoiNjc5ODQ0OTU1MTczMTUwNzUzMDIyNTc0MTIyNjQxNzY5ODE0OTI3OTMyMzExNjA5NTgxMTA3MTYiLCJzY2FsZSI6MTk0fV0sInpvb20iOnsiYmlnSW50IjoiMzExMDM5MDY3MTMwMDE4NDYwOTMwMDk0Mjg2MDE0MDExNzMzMzc5NDAyOTg4MTA1NTQ3NjgxMTA2NTAyNTEyOTM2NDQwNTkxNjA0MzU2MDQwMzI4ODMxNjA2NzUyMzgzMDAwODEzNjkyMjc4Nzc2MDgiLCJzY2FsZSI6MTk0fSwibWF4X2l0ZXIiOjUwMDAsInNtb290aCI6dHJ1ZSwicGFsZXR0ZSI6eyJpZCI6Im1hbmRlbGJyb3QiLCJkZW5zaXR5IjoiLTExIiwicm90YXRlIjoiLTExIn19',
}

export function scenarios() {
    const result = Object.entries(FAVORITES).map(([name, encoded]) => {
        const p = JSON.parse(atob(encoded))
        return {name, center: p.center.map(fxp.fromJSON), zoom: fxp.fromJSON(p.zoom), maxIter: p.max_iter}
    })
    // Deeper zooms towards the location of the E316 test task
    const deep = tasks.parse(tasks.E316)
    for (const [exp, maxIter] of [[150, 10000], [280, 10000]]) {
        const scale = Math.ceil(exp * Math.log2(10)) + 20
        const center = deep.frameTopLeft.map(v => v.withScale(scale))
        const zoom = new fxp.FxP(10n ** BigInt(exp) << BigInt(scale), scale)
        result.push({name: `E316 location at 1e${exp}, ${maxIter} iter`, center, zoom, maxIter})
    }
    return result
}

// Same frame computation as index.js (canvas2complex), for a W x H canvas
export function createTask({center, zoom, maxIter}, w = W, h = H) {
    const requiredPrecision = zoom.multiply(fxp.fromNumber(w).withScale(zoom.scale)).bits() + 5
    const precision = Math.max(58, requiredPrecision)
    zoom = zoom.withScale(precision)
    center = center.map(c => c.withScale(precision))
    const fw = fxp.fromNumber(w, precision)
    const fh = fxp.fromNumber(h, precision)
    const scale = zoom.multiply(fw).divide(fxp.fromNumber(4, precision))
    const canvas2complex = (x, y) => [
        fxp.fromNumber(x, precision).subtract(fw.divide(fxp.fromNumber(2, precision))).divide(scale).add(center[0]),
        fxp.fromNumber(y, precision).subtract(fh.divide(fxp.fromNumber(2, precision))).divide(scale).add(center[1]),
    ]
    return {
        type: 'task', jobId: 1, jobToken: null, xOffset: 0, yOffset: 0, w, h, frameWidth: w, frameHeight: h,
        frameTopLeft: canvas2complex(0, 0), frameBottomRight: canvas2complex(w, h),
        paramHash: `${maxIter}-true`, skipTopLeft: false, smooth: true, maxIter, precision, requiredPrecision,
        resetCaches: true,
    }
}

export async function render(task, useBla) {
    const mandelbrot = new MandelbrotPerturbation(new WorkerContext())
    mandelbrot.useBla = useBla
    return await mandelbrot.process(task)
}

export function compare(a, b) {
    let differing = 0
    let maxDiff = 0
    let minIter = Infinity
    let maxIter = 0
    for (let i = 0; i < a.values.length; i++) {
        const diff = Math.abs(a.values[i] - b.values[i])
        if (diff > 0) differing++
        maxDiff = Math.max(maxDiff, diff)
        minIter = Math.min(minIter, a.values[i])
        maxIter = Math.max(maxIter, a.values[i])
    }
    return {differing, maxDiff, total: a.values.length, minIter, maxIter}
}

// Best time of a few runs, so JIT warm-up and noise don't skew the comparison
async function bestOf(task, useBla, runs = 2) {
    let best = null
    for (let i = 0; i < runs; i++) {
        const result = await render(task, useBla)
        if (best === null || result.stats.time < best.stats.time) best = result
    }
    return best
}

export async function run(log = console.log) {
    // warm up the JIT for both code paths
    for (const scenario of scenarios()) {
        const task = createTask(scenario, 40, 30)
        await render(task, false)
        await render(task, true)
    }
    for (const scenario of scenarios()) {
        const task = createTask(scenario)
        const plain = await bestOf(task, false)
        const bla = await bestOf(task, true)
        const {differing, maxDiff, total, minIter, maxIter} = compare(plain, bla)
        const hp = r => `${r.stats.timeHighPrecision.toFixed(0)}ms reference`
        log(`${scenario.name} (precision ${task.precision}, iterations ${minIter}-${maxIter}): ` +
            `plain ${plain.stats.time.toFixed(0)}ms (${hp(plain)}), ` +
            `BLA ${bla.stats.time.toFixed(0)}ms (${hp(bla)}), ` +
            `speedup ${(plain.stats.time / bla.stats.time).toFixed(1)}x, ` +
            `${differing}/${total} pixels differ (${(100 * differing / total).toFixed(3)}%), max diff ${maxDiff} iter`)
    }
}

if (typeof process !== 'undefined' && process.argv[1]?.replaceAll('\\', '/').endsWith('test/blaBenchmark.mjs')) {
    await run()
}
