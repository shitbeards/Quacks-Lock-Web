import 'seedrandom'

function random(max) {
    Math.round(Math.random() * max) + 1
}

export function hatch(quack_code, skins=[], voices=[]) {
    Math.seedrandom(quack_code)  // Seed Math.random() for deterministic values
    const skin  = skins[random(skins.length)]
    const voice = voices[random(voices.length)]
    Math.seedrandom()  // Return Math.random() back to normal
    return [skin, voice]
}
