<script lang="ts">
  import { checkGameUpdates } from '../lib/updates/checkGameUpdates';

  document.addEventListener('all-addons-started', () => {
    checkGameUpdates()
      .then(() => {
        console.log('startup game update check complete');
      })
      .catch((err) => {
        console.error('startup game update check failed', err);
      });
  });
</script>
