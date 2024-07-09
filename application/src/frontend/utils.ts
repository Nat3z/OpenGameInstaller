function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}

interface ConsumableRequest extends RequestInit {
  consume?: 'json' | 'text';
}
export async function safeFetch(url: string, options: ConsumableRequest = { consume: 'json' }) {
  return new Promise<any>((resolve, reject) => {
    fetch(url, {
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
          const taskResponse = await fetch(`http://localhost:7654/defer/${taskID}`, {
            headers: {
              'Authorization': getSecret()!!
            }
          });
          if (taskResponse.status === 404) {
            reject('Task not found when deferring.');
            clearInterval(deferInterval);
          }
          if (taskResponse.status === 200) {
            const taskData = await taskResponse.json();
            clearInterval(deferInterval);
            resolve(taskData);
          }
        }, 100);
      }
      else {
        if (!options.consume || options.consume === 'json') return resolve(response.json());
        else if (options.consume === 'text') return resolve(response.text());
        else throw new Error('Invalid consume type');
      }
    });
  });
}