import test from 'node:test'
import assert from 'node:assert/strict'
import {BlaTable} from '../bla.mjs'
import {scenarios, createTask, render, compare} from './blaBenchmark.mjs'

// Reference orbit of c, zs[n] = Zₙ₊₁ like MandelbrotPerturbation.calculate_reference produces
function orbit(cr, ci, n) {
    const zs = []
    let zr = 0, zi = 0
    for (let k = 0; k < n; k++) {
        [zr, zi] = [zr * zr - zi * zi + cr, 2 * zr * zi + ci]
        zs.push([zr, zi])
    }
    return zs
}

test('a BLA run matches iterating the perturbation step by step', () => {
    // c in a period 3 bulb, so the orbit stays bounded
    const zs = orbit(-1.754, 0.001, 600)
    const dcr = 3e-40, dci = -2e-40
    const table = new BlaTable(zs, zs.length - 2, Math.hypot(dcr, dci))
    assert.ok(table.levels.length > 4)

    // every valid run starting at 0 must agree with the exact recurrence εₙ₊₁ = 2·Zₙ·εₙ + εₙ² + δ
    let checked = 0
    for (let j = 1; j <= table.levels.length; j++) {
        const level = table.levels[j - 1]
        if (!(dcr * dcr + dci * dci < level.r2[0])) continue
        let er = dcr, ei = dci
        for (let n = 0; n < 2 ** j; n++) {
            const [zr, zi] = zs[n];
            [er, ei] = [2 * (zr * er - zi * ei) + er * er - ei * ei + dcr, 2 * (zr * ei + zi * er) + 2 * er * ei + dci]
        }
        const blaR = level.ar[0] * dcr - level.ai[0] * dci + level.br[0] * dcr - level.bi[0] * dci
        const blaI = level.ar[0] * dci + level.ai[0] * dcr + level.br[0] * dci + level.bi[0] * dcr
        assert.ok(Math.hypot(blaR - er, blaI - ei) <= 1e-9 * Math.hypot(er, ei), `level ${j}`)
        checked++
    }
    assert.ok(checked > 0)
})

test('a run is never valid when the shorter run at the same start is not', () => {
    const zs = orbit(-1.754, 0.001, 600)
    const table = new BlaTable(zs, zs.length - 2, 1e-30)
    for (let j = 1; j < table.levels.length; j++) {
        const shorter = table.levels[j - 1].r2, longer = table.levels[j].r2
        for (let i = 0; i < longer.length; i++) {
            assert.ok(longer[i] <= shorter[2 * i], `level ${j + 1} index ${i}`)
        }
    }
})

test('rendering with BLA gives the same image as without', async () => {
    const scenario = scenarios().find(s => s.name.includes('1e150'))
    const task = createTask(scenario, 80, 60)
    const plain = await render(task, false)
    const bla = await render(task, true)
    assert.equal(compare(plain, bla).differing, 0)
})
