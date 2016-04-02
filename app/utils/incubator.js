import 'seedrandom'

function random(list) {
    return list[Math.floor(Math.random()*list.length)]
}

export function hatch(quack_code, skins=[], quacks=[]) {
    Math.seedrandom(quack_code)  // Seed Math.random() for deterministic values
    const skin  = random(skins)
    const quack = random(quacks)
    Math.seedrandom()  // Return Math.random() back to normal
    return [skin, quack]
}

export function incubator(skins=[], quacks=[], known_genetics={}) {
    // Make copy of skins and quacks
    const held_skins    = skins.slice(0)
    const held_quacks   = quacks.slice(0)

    return function(quack_code) {
        if (quack_code in known_genetics) {
            return known_genetics[quack_code]
        }
        return hatch(quack_code, held_skins, held_quacks)
    }
}
