import './main.css!'

import router from './router'

import {ws_url} from 'consts.js'

router.start({
    data() {
        return {
            loading: true,
            quacks: []
        }
    },
    computed: {

    },
    created() {

    },
    ready() {
        window.app = this

        //Set up websocket
        this.ws = new WebSocket(ws_url)
        this.ws.onopen = (evt)=>{
            console.log('hello');
        }
        this.ws.onmessage = (evt)=>{
            this.make_quack(evt.data)
        }
        this.ws.onclose = (evt)=>{
            console.log('Goodbye');
        }

        this.loading = false
    },
    methods: {
        send_quack(evt){
            var x = evt.code.split('Key')
            if(x.length > 1) this.ws.send(x[1])
            else {
                x = evt.code.split('Digit')
                if(x.length > 1) this.ws.send(x[1])
            }
        },
        make_quack(key){
            this.quacks.push(key);
            setTimeout( () => {
                this.quacks.shift();
            }, 400);
        }
    },
}, 'body')
