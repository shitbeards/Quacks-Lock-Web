import Vue from 'vue'
import VueRouter from 'vue-router'

import {debug} from 'consts'


Vue.use(VueRouter)
Vue.config.debug = debug

const router = new VueRouter()

export default router
