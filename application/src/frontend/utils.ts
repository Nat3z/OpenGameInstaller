function getSecret() {
  const urlParams = new URLSearchParams(window.location.search);
  const addonSecret = urlParams.get('secret');
  return addonSecret;
}

export async function safeFetch(url: string, options: RequestInit = {}) {
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
    return response.json();
  });
}