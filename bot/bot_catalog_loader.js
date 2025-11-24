async function safeGet(api, path) {
  try {
    const res = await api.get(path);
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    return [];
  }
}

function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function findCodigoInObject(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object') return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  const keys = Object.keys(obj);
  // direct matches
  for (const k of keys) {
    if (/^(codigo|cod|code)$/i.test(k) && obj[k]) {
      return String(obj[k]).trim();
    }
    if (/codigo/i.test(k) && obj[k]) {
      return String(obj[k]).trim();
    }
  }
  // check common patterns (e.g. "Codigo","CodigoProduto","CodigoProd")
  for (const k of keys) {
    if (/cod/i.test(k) && obj[k]) {
      return String(obj[k]).trim();
    }
  }
  // fallback: Id fields
  for (const k of keys) {
    if (/^id$/i.test(k) && obj[k]) return String(obj[k]).trim();
    if (/^id_/i.test(k) && obj[k]) return String(obj[k]).trim();
  }

  // recursive search in nested objects/arrays
  for (const k of keys) {
    try {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const found = findCodigoInObject(v, seen);
        if (found) return found;
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Carrega registros de endpoints comuns e retorna { byNormalizedName, byOriginalName, items }
 * - api: instância axios
 * - options.endpoints: array de endpoints a consultar (padrão: ['/produtos','/ensacados','/cereais'])
 */
async function loadCatalogFromApi(api, options = {}) {
  const endpoints = options.endpoints || ['/produtos', '/ensacados', '/cereais'];

  const all = [];
  for (const ep of endpoints) {
    try {
      const arr = await safeGet(api, ep);
      if (Array.isArray(arr) && arr.length > 0) {
        // append items
        for (const it of arr) all.push(it);
      }
    } catch (e) {
      // ignore individual endpoint errors
    }
  }

  const byNormalizedName = {};
  const byOriginalName = {};
  const items = [];

  for (const raw of all) {
    if (!raw || typeof raw !== 'object') continue;

    // try common name fields
    const nameCandidates = ['Nome', 'nome', 'Name', 'name', 'Descricao', 'descricao', 'titulo', 'Titulo'];
    let name = null;
    for (const k of nameCandidates) {
      if (raw[k]) {
        name = String(raw[k]).trim();
        break;
      }
    }
    if (!name) {
      // try any string field as name fallback
      for (const k of Object.keys(raw)) {
        if (typeof raw[k] === 'string' && raw[k].trim().length > 0) {
          name = String(raw[k]).trim();
          break;
        }
      }
    }
    if (!name) continue;

    const code = findCodigoInObject(raw) || '';
    const normalized = normalizeName(name);
    const item = { name, code: String(code || '').trim(), raw };
    items.push(item);

    if (normalized) byNormalizedName[normalized] = item.code || '';
    byOriginalName[name] = item.code || '';
  }

  return {
    byNormalizedName,
    byOriginalName,
    items,
  };
}

export { loadCatalogFromApi };
