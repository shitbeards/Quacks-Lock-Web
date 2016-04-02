import Vue from 'vue'
import VueRouter from 'vue-router'
import VueTouch from 'vue-touch'

import {debug} from 'consts'


Vue.use(VueRouter)
Vue.use(VueTouch)
Vue.config.debug = debug

const router = new VueRouter({
    history: true,
})

export default router
