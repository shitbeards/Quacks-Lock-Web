import './duck.css!';
import Vue from 'vue';

import ducks from './ducks/ducks';

export default Vue.extend({
    data(){
        return {

        }
    },
    created: function(){
        this.$options.template = ducks[Math.floor(Math.random()*ducks.length)];
    }
});
