<script lang="ts">
  interface Props {
    fill?: string;
    width?: string;
    height?: string;
  }

  let { fill = "#e8eaed", width = "24px", height = "24px" }: Props = $props();
</script>
<svg xmlns="http://www.w3.org/2000/svg" height={height} viewBox="0 -960 960 960" width={width} fill={fill}><path d="m341-46-18-139q-5-2-10-5l-10-6-129 55L34-385l111-84v-22L34-575l140-242 131 54q5-3 9-5.5t9-4.5l18-141h278l18 141q5 2 10 4.5t10 5.5l129-54 140 242-112 84v11q0 3-.5 5.5t-.5 5.5l112 84-141 244-129-55q-5 3-9 6t-9 5L619-46H341Zm138-294q58 0 99-41t41-99q0-58-41-99t-99-41q-58 0-99 41t-41 99q0 58 41 99t99 41Z"/></svg>