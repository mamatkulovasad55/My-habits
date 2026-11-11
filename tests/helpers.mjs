// Общие помощники для тестов: подменённые часы, KV и сеть (GitHub + Telegram).
const RealDate = Date;
let NOW = RealDate.now();

/** Подменить «сейчас». ms — метка времени UTC. */
export function setNow(ms) {
  NOW = ms;
}

class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(NOW);
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FakeDate;

/** Время Ташкента (UTC+5) → метка UTC. */
export const tashkent = (y, mo, d, h = 0, mi = 0) => RealDate.UTC(y, mo - 1, d, h - 5, mi);

/** KV в памяти со счётчиками и возможностью «сломать» операции. */
export function memoryKV() {
  const map = new Map();
  const kv = {
    map,
    puts: 0,
    failPut: false,
    failGet: false,
    async get(k, type) {
      if (kv.failGet) throw new Error('KV get limit');
      if (!map.has(k)) return null;
      return type === 'json' ? JSON.parse(map.get(k)) : map.get(k);
    },
    async put(k, v) {
      if (kv.failPut) throw new Error('KV put limit exceeded');
      kv.puts++;
      map.set(k, v);
    },
  };
  return kv;
}

/** Подмена fetch: GitHub Contents API с одним файлом и Telegram Bot API. */
export function fakeNet() {
  const net = { remote: null, sha: 0, ghPuts: 0, tg: [], tgFail: 0 };
  globalThis.fetch = async (url, o = {}) => {
    url = String(url);
    if (url.startsWith('https://api.github.com/')) {
      if ((o.method || 'GET') === 'GET') {
        if (!net.remote) return new Response('{}', { status: 404 });
        if (String(o.headers?.Accept).includes('raw')) return new Response(net.remote);
        return new Response(JSON.stringify({ sha: 's' + net.sha, content: Buffer.from(net.remote).toString('base64') }));
      }
      const b = JSON.parse(o.body);
      if (net.remote && b.sha !== 's' + net.sha) return new Response('{}', { status: 409 });
      net.remote = Buffer.from(b.content, 'base64').toString();
      net.sha++;
      net.ghPuts++;
      return new Response('{}');
    }
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      let body = o.body;
      if (typeof body === 'string') body = JSON.parse(body);
      else if (body instanceof FormData) body = Object.fromEntries([...body.entries()]);
      if (net.tgFail > 0) {
        net.tgFail--;
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests' }));
      }
      net.tg.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }));
    }
    throw new Error('unexpected fetch ' + url);
  };
  return net;
}

export async function runCron(worker, env) {
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
