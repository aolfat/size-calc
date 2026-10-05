// Tradier REST: base URL and auth headers from the settings inputs (saveKey keeps storage in step on every keystroke).

export function baseUrl() {
  const env = document.getElementById('apiEnv').value;
  return env === 'sandbox' ? 'https://sandbox.tradier.com/v1' : 'https://api.tradier.com/v1';
}

export function headers() {
  return {
    'Authorization': 'Bearer ' + document.getElementById('apiKey').value.trim(),
    'Accept': 'application/json'
  };
}
