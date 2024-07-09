function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}

interface ConsumableRequest extends RequestInit {
  consume?: 'json' | 'text';
}
export async function safeFetch(url: string, options: ConsumableRequest = { consume: 'json' }) {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': getSecret()!!
    }
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    const clonedCheck = response.clone();
    // if the task is deferred, we should poll the task until it's done.
    if (response.status === 202) {
      const taskID = (await clonedCheck.json()).taskID;
      const deferInterval = setInterval(async () => {
        const taskResponse = await fetch(`/defer/${taskID}`, {
          headers: {
            'Authorization': getSecret()!!
          }
        });
        if (taskResponse.status === 404) {
          return;
        }
        if (taskResponse.status === 202) {
          return;
        }
        const taskData = await taskResponse.json();
        clearInterval(deferInterval);
        return taskData;
      }, 100);
    }
    else {
      if (!options.consume || options.consume === 'json') return response.json();
      else if (options.consume === 'text') return response.text();
      else throw new Error('Invalid consume type');
    }

  });
}