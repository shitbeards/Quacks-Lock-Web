import 'seedrandom'

function random(max) {
    return Math.round(Math.random() * max)
}

export function hatch(quack_code, skins=[], quacks=[]) {
    Math.seedrandom(quack_code)  // Seed Math.random() for deterministic values
    const skin  =  skins[random( skins.length - 1)]
    const quack = quacks[random(quacks.length - 1)]
    Math.seedrandom()  // Return Math.random() back to normal
    return [skin, quack]
}

export function incubator(skins=[], quacks=[]) {
    // Make copy of skins and quacks
    const held_skins  = skins.slice(0)
    const held_quacks = quacks.slice(0)

    return function(quack_code) {
        return hatch(quack_code, held_skins, held_quacks)
    }
}
