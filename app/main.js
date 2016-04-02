import './main.css!'

import router from './router'

import {ws_url} from 'consts.js'
import {incubator} from 'app/utils/incubator'

import skins from 'resources/skins/skins'


function randomX(){
    return Math.floor( Math.random() * (window.innerWidth-180) ) + 'px'
}

function randomY(){
    return Math.floor( Math.random() * (window.innerHeight-140) ) + 'px'
}

router.start({
    data() {
        return {
            loading: true,
            ducks: [],
            hatch: null,
            count: null,
        }
    },
    computed: {

    },
    created() {

    },
    ready() {
        window.app = this

        const quacks = document.getElementsByTagName("audio")
        this.hatch   = incubator(skins, quacks)

        //Set up websocket
        this.ws = new WebSocket(ws_url)
        this.ws.onopen = (evt) => {
        }
        this.ws.onmessage = (evt) => {
            const data = JSON.parse(evt.data)
            this.make_quack(data.Key)
            this.count = data.Quacks
        }
        this.ws.onclose = (evt) => {
        }

        this.loading = false
    },
    methods: {
        tap_quack() {
            this.ws.send('!')
        },
        send_quack(evt) {
            let x = evt.code.split('Key')
            if(x.length > 1) this.ws.send(x[1])
            else {
                x = evt.code.split('Digit')
                if(x.length > 1) this.ws.send(x[1])
            }
        },
        make_quack(key) {
            const duck    = this.hatch(key)
            duck.position = {x: randomX(), y: randomY()}

            duck.quack.pause()
            duck.quack.currentTime = 0
            duck.quack.play()

            this.ducks.push(duck)
            setTimeout(() => this.ducks.shift(), 400)
        },
    },
}, 'body')
