import 'seedrandom'

function random(max) {
    Math.round(Math.random() * max)
}

export function hatch(quack_seed, skins=[], quacks=[]) {
    Math.seedrandom(quack_seed)  // Seed Math.random() for deterministic values
    const skin  =  skins[random( skins.length - 1)]
    const quack = quacks[random(quacks.length - 1)]
    Math.seedrandom()  // Return Math.random() back to normal
    return [skin, quack]
}
