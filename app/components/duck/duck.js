import './duck.css!'
import Vue from 'vue'

export default Vue.extend({
    props: ['skin', 'key'],
    data(){
        return {

        }
    },
    created() {
        this.$options.template = this.skin
    },
})
