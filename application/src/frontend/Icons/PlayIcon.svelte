<script lang="ts">
  interface Props {
    fill?: string;
    width?: string;
    height?: string;
  }

  let { fill = "#e8eaed", width = "24px", height = "24px" }: Props = $props();
</script>
<svg xmlns="http://www.w3.org/2000/svg" height={height} viewBox="0 -960 960 960" width={width} fill={fill}><path d="M286-139v-682l537 341-537 341Z"/></svg>