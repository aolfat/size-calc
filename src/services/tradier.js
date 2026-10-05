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
