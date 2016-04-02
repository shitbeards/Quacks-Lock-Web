import './main.css!'

import router from './router'

import {ws_url} from 'consts.js'
import {incubator} from 'app/utils/incubator'

import skins from 'resources/skins/skins'


function randomX(){
    return Math.floor( Math.random() * (window.innerWidth-30) ) + 'px'
}

function randomY(){
    return Math.floor( Math.random() * (window.innerHeight-30) ) + 'px'
}

router.start({
    data() {
        return {
            loading: true,
            ducks: [],
            hatch: null,
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
            console.log('hello')
        }
        this.ws.onmessage = (evt) => {
            this.make_quack(evt.data)
        }
        this.ws.onclose = (evt) => {
            console.log('Goodbye')
        }

        this.loading = false
    },
    methods: {
        send_quack(evt){
            let x = evt.code.split('Key')
            if(x.length > 1) this.ws.send(x[1])
            else {
                x = evt.code.split('Digit')
                if(x.length > 1) this.ws.send(x[1])
            }
        },
        make_quack(key){
            const [skin, quack] = this.hatch(key)
            const position      = {x: randomX(), y: randomY()}
            if(!quack.paused || quack.currentTime){
                quack.pause()
                quack.currentTime = 0
                quack.play()
            } else {
                quack.play()
            }
            this.ducks.push({
                key,
                skin,
                position,
            })
            setTimeout( () => {
                this.ducks.shift()
            }, 400)
        },
    },
}, 'body')
