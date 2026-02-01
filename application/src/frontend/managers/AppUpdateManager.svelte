<script lang="ts">
  import { checkGameUpdates } from '../lib/updates/checkGameUpdates';

  document.addEventListener('all-addons-started', () => {
    checkGameUpdates().then(() => {
      console.log('startup game update check complete');
    });
  });
</script>
