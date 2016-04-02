import 'seedrandom'

function random(list) {
    return list[Math.floor(Math.random()*list.length)]
}

export function hatch(key, skins=[], quacks=[]) {
    Math.seedrandom(key)  // Seed Math.random() for deterministic values
    const skin  = random(skins)
    const quack = random(quacks)
    Math.seedrandom()  // Return Math.random() back to normal
    return {key, skin, quack}
}

export function incubator(skins=[], quacks=[], known_genetics={}) {
    return function(key) {
        if (key in known_genetics) {
            return known_genetics[key]
        }
        return hatch(key, skins, quacks)
    }
}
