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
  }).then((response) => {
    if (!response.ok) {
      throw new Error(response.statusText);
    }

    if (!options.consume || options.consume === 'json') return response.json();
    else if (options.consume === 'text') return response.text();
    else throw new Error('Invalid consume type');
  });
}