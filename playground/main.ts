/// <reference types="vite/client" />
import ui from "@nuxt/ui/vue-plugin";
import { createApp } from "vue";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheets are imported for their side effect
import "./main.css";
// oxlint-disable-next-line import/no-unassigned-import
import "../src/vue/style.css";
import App from "./App.vue";

createApp(App).use(ui).mount("#app");
