/// <reference types="vite/client" />
import { createApp } from "vue";
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is imported for its side effect
import "../src/vue/style.css";
import App from "./App.vue";

createApp(App).mount("#app");
