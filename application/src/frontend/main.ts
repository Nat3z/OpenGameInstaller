import './app.css';
import { mount } from 'svelte';
import App from '@/frontend/App.svelte';

const app = mount(App, {
  target: document.body,
  props: {},
});

export default app;
