function toUrl(input, params = {}) {
  const url = new URL(input, input.startsWith('http') ? undefined : 'http://localhost');
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function readResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(method, url, options = {}) {
  const { params, headers, timeout, body } = options;
  const resolvedUrl = toUrl(url, params);
  const controller = timeout ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const response = await fetch(resolvedUrl.toString(), {
      method,
      headers,
      signal: controller ? controller.signal : undefined,
      body: body === undefined ? undefined : (typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body)),
    });

    const data = await readResponse(response);
    return { data, status: response.status, headers: response.headers };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function create({ baseURL = '', timeout = 0, headers: defaultHeaders = {} } = {}) {
  const joinUrl = (path) => {
    if (!baseURL) return path;
    return new URL(path, baseURL).toString();
  };

  return {
    get(path, options = {}) {
      return request('GET', joinUrl(path), { ...options, timeout: options.timeout || timeout, headers: { ...defaultHeaders, ...(options.headers || {}) } });
    },
    post(path, body, options = {}) {
      return request('POST', joinUrl(path), {
        ...options,
        timeout: options.timeout || timeout,
        headers: { ...defaultHeaders, 'Content-Type': 'application/json', ...(options.headers || {}) },
        body,
      });
    },
  };
}

function get(url, options = {}) {
  return request('GET', url, options);
}

function post(url, body, options = {}) {
  return request('POST', url, { ...options, body });
}

module.exports = { create, get, post, request };
