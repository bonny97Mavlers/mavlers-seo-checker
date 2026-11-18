// Thin API client. Adds the current user (role scaffolding) and the optional shared API token.
const store = {
  get user() { return localStorage.getItem('seo.user') || ''; },
  set user(v) { localStorage.setItem('seo.user', v); },
  get token() { return localStorage.getItem('seo.token') || ''; },
  set token(v) { localStorage.setItem('seo.token', v); },
};

async function request(method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (store.user) headers['x-user-id'] = store.user;
  if (store.token) headers.authorization = 'Bearer ' + store.token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const t = prompt('This SEO checker is protected. Enter the access token:');
    if (t) { store.token = t; return request(method, url, body); }
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b || {}),
  patch: (u, b) => request('PATCH', u, b),
  put: (u, b) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  store,
  /** URL with token for links opened in a new tab (reports, CSV). */
  link: (u) => u + (u.includes('?') ? '&' : '?') + new URLSearchParams({ ...(store.token ? { token: store.token } : {}), ...(store.user ? { uid: store.user } : {}) }),
};
